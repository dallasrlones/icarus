import { runOneShot, type CursorOptions } from "../cursor.js";
import { modelFor } from "../storage/settings.js";
import { splitSentencesForTTS, stripMarkdownForSpeech } from "./tts.js";

/**
 * Phase 15.1 — "Speak a paragraph, not the whole book."
 *
 * The TTS pipeline used to feed the assistant's full reply through
 * the speaker, sentence by sentence. Long replies (anything over a
 * paragraph) became "listen to audio for hours" — fine in chat,
 * miserable spoken aloud.
 *
 * This module computes a *spoken* version of an assistant reply:
 *
 *   1. If the reply is already short (under SPOKEN_PASSTHROUGH_CHARS
 *      after markdown stripping), use it as-is. Skips the LLM call
 *      so short answers stay zero-latency.
 *   2. Otherwise, fire a tight `cursor-agent` summary call:
 *      "Summarize the assistant reply below in at most 3 sentences,
 *       no markdown, suitable for text-to-speech."
 *   3. If the summary call fails or returns empty, fall back to a
 *      deterministic truncation: first 3 sentences + a one-line
 *      outro pointing the user back to chat.
 *
 * The chat display is untouched — the full reply still goes into
 * the persisted assistant message. The spoken text is purely a
 * TTS-side concern, computed on demand by the client's "after the
 * turn ends" hook in the store.
 */

/**
 * Length below which we skip the summary entirely. ~600 chars =
 * roughly 100 words, ~30s of speech at TTS pace. Above that,
 * summarize.
 */
export const SPOKEN_PASSTHROUGH_CHARS = 600;

/**
 * Hard cap on the cursor-agent summary output (post-strip). If the
 * model returns more than this we treat it as a misbehavior and
 * fall back to the truncate path. Keeps a runaway summary from
 * defeating the whole point of this module.
 */
const SPOKEN_SUMMARY_CHAR_CAP = 700;

/**
 * Provenance tag on the result so the client (and logs) can tell
 * what produced the spoken text. `passthrough` and `truncate`
 * are deterministic; `summary` rode an LLM call.
 */
export type SpokenSource = "passthrough" | "summary" | "truncate" | "empty";

export interface SpokenResult {
  spoken_text: string;
  source: SpokenSource;
  /** Length of the cleaned (markdown-stripped) original, for logging. */
  original_chars: number;
}

/**
 * Public entry point. Caller passes the assistant's full reply
 * text and the cursor options. Returns the spoken version and its
 * provenance. Never throws — failures degrade to truncate or empty.
 */
export async function computeSpokenForText(
  text: string,
  cursorOpts: CursorOptions,
): Promise<SpokenResult> {
  const cleaned = stripMarkdownForSpeech(text);
  const original_chars = cleaned.length;

  if (!cleaned) {
    return { spoken_text: "", source: "empty", original_chars };
  }

  if (cleaned.length <= SPOKEN_PASSTHROUGH_CHARS) {
    // Short replies: speak the whole thing. No reason to pay for
    // an LLM call (or add latency) when the original already fits.
    return { spoken_text: cleaned, source: "passthrough", original_chars };
  }

  try {
    const summary = await summarizeViaAgent(text, cursorOpts);
    const cleanedSummary = stripMarkdownForSpeech(summary);
    if (cleanedSummary && cleanedSummary.length <= SPOKEN_SUMMARY_CHAR_CAP) {
      return {
        spoken_text: cleanedSummary,
        source: "summary",
        original_chars,
      };
    }
    // Either empty or absurdly long — agent didn't follow the
    // instruction, fall through to the deterministic truncate.
    if (process.env.CURSOR_DEBUG) {
      console.warn(
        `[voice] summary fell outside bounds (${cleanedSummary.length} chars); using truncate fallback`,
      );
    }
  } catch (err) {
    // Network blip, agent error, etc. Don't fail the user-facing
    // playback — fall back to the deterministic truncate.
    if (process.env.CURSOR_DEBUG) {
      console.error(
        `[voice] summary call failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return {
    spoken_text: truncateForSpeech(cleaned),
    source: "truncate",
    original_chars,
  };
}

/**
 * Deterministic fallback: take the first ~3 sentences (or up to
 * SPOKEN_PASSTHROUGH_CHARS, whichever comes first) and append a
 * single outro sentence so the listener knows there's more in chat.
 */
function truncateForSpeech(cleaned: string): string {
  const sentences = splitSentencesForTTS(cleaned);
  if (sentences.length === 0) return "";
  const picked: string[] = [];
  let total = 0;
  for (const s of sentences) {
    if (picked.length >= 3) break;
    if (total + s.length > SPOKEN_PASSTHROUGH_CHARS && picked.length > 0) break;
    picked.push(s);
    total += s.length + 1;
  }
  // The outro is intentionally short and uses words the TTS handles
  // cleanly. "Full reply is in chat." is one short sentence; keeps
  // the listener oriented without padding much audio.
  return picked.join(" ") + " Full reply is in chat.";
}

/**
 * Single-shot summary call. The prompt is intentionally terse —
 * any extra prose risks the model writing AROUND the instruction
 * instead of executing it. We cap output via the prompt and
 * re-cap on the parse side via SPOKEN_SUMMARY_CHAR_CAP.
 */
async function summarizeViaAgent(
  text: string,
  cursorOpts: CursorOptions,
): Promise<string> {
  const prompt = [
    "Summarize the assistant reply below for text-to-speech playback.",
    "",
    "Rules:",
    "- At most 3 sentences total.",
    "- Plain prose only. No markdown, no headings, no bullets, no code.",
    "- Speak in first person matching the original ('I rewrote...', not 'The reply explains...').",
    "- Do NOT add an intro like 'Here is a summary:'. Output the summary text directly.",
    "- If the reply is mostly code or a long list, describe it briefly instead of reading it.",
    "",
    "ASSISTANT REPLY:",
    text,
  ].join("\n");
  // Phase 20 — spoken-summary rides the chat-model role since it's
  // a user-facing rewrite of a chat reply, not an autonomous
  // decision. Keeps the summary cheap/fast like the rest of chat.
  const opts = { ...cursorOpts, model: await modelFor("chat", cursorOpts.model) };
  const out = await runOneShot(opts, prompt);
  return out.text.trim();
}
