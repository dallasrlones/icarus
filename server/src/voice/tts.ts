import { authHeaders, type VoiceConfig } from "./config.js";
import { VoiceProxyError } from "./stt.js";

/**
 * Phase 15 — TTS proxy.
 *
 * Forwards a synth request to the Jetson Orin `tts-service`
 * (Coqui XTTS-v2). Returns a fully-buffered WAV (24kHz PCM16).
 *
 * Sentence chunking lives in `splitSentencesForTTS` so the client
 * can drive incremental playback as the assistant streams text.
 * Buffering each chunk fully on the server keeps the wire protocol
 * simple — XTTS-v2 itself doesn't stream.
 */

export interface SynthesizeOptions {
  text: string;
  voice?: string;
  language?: string;
  /** 0.5 .. 2.0 multiplier; 1.0 = natural pace. */
  speed?: number;
}

export interface SynthesizeResult {
  audio: Uint8Array;
  contentType: string;
  /** From `X-Voice` header on the upstream response, if present. */
  voice?: string;
  /** From `X-Language` header on the upstream response, if present. */
  language?: string;
}

export async function synthesize(
  cfg: VoiceConfig,
  opts: SynthesizeOptions,
): Promise<SynthesizeResult> {
  if (!cfg.ttsUrl) {
    throw new VoiceProxyError("VOICE_TTS_URL not configured", 503);
  }
  if (!opts.text || !opts.text.trim()) {
    throw new VoiceProxyError("text is required", 400);
  }
  // Orin clamps at 5000 chars; clamp here so a malformed client
  // doesn't get a confusing upstream 422.
  const text = opts.text.length > 4900 ? opts.text.slice(0, 4900) : opts.text;

  let resp: Response;
  try {
    resp = await fetch(`${cfg.ttsUrl.replace(/\/$/, "")}/synthesize`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(cfg.ttsAuth) },
      body: JSON.stringify({
        text,
        voice: opts.voice ?? cfg.ttsVoice,
        language: opts.language ?? cfg.ttsLanguage,
        speed: typeof opts.speed === "number" ? opts.speed : 1.0,
      }),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new VoiceProxyError(`tts upstream unreachable: ${msg}`, 502);
  }

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new VoiceProxyError(`tts upstream ${resp.status}`, 502, body);
  }

  const ab = await resp.arrayBuffer();
  return {
    audio: new Uint8Array(ab),
    contentType: resp.headers.get("content-type") || "audio/wav",
    voice: resp.headers.get("x-voice") || undefined,
    language: resp.headers.get("x-language") || undefined,
  };
}

/**
 * Split assistant text into utterance-sized chunks for incremental
 * synthesis. We chunk by sentence so the client can start playback
 * while later chunks are still being generated upstream.
 *
 * Heuristics:
 *   - Hard split on `.!?` followed by whitespace or end of string.
 *   - Keep each chunk under `maxChars` (XTTS-v2 has near-constant
 *     per-token latency, so smaller chunks ⇒ faster first audio).
 *   - Markdown noise (#, *, -, code fences) and bare URLs get
 *     stripped — they read poorly aloud.
 *   - Empty / whitespace-only segments are dropped.
 */
export function splitSentencesForTTS(input: string, maxChars = 240): string[] {
  if (!input || !input.trim()) return [];
  const cleaned = stripMarkdownForSpeech(input);
  if (!cleaned.trim()) return [];

  const out: string[] = [];
  // Greedy regex: capture a run ending in . ! ? plus trailing whitespace,
  // OR a final fragment with no terminator. The trailing-whitespace
  // group ensures we don't split mid-decimal ("3.14") because the next
  // char is a digit, not whitespace.
  const sentenceRe = /[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g;
  let m: RegExpExecArray | null;
  while ((m = sentenceRe.exec(cleaned)) !== null) {
    const sent = m[0].trim();
    if (!sent) continue;
    if (sent.length <= maxChars) {
      out.push(sent);
    } else {
      // Long sentence: secondary split on commas / semicolons /
      // colons / em-dashes to keep chunks small.
      const subs = sent
        .split(/(?<=[,;:—])\s+/)
        .map((s) => s.trim())
        .filter(Boolean);
      let buf = "";
      for (const s of subs) {
        if ((buf + " " + s).trim().length > maxChars) {
          if (buf) out.push(buf.trim());
          buf = s;
        } else {
          buf = (buf + " " + s).trim();
        }
      }
      if (buf) out.push(buf.trim());
    }
  }
  return out;
}

/**
 * Strips markdown noise so a TTS engine doesn't read "asterisk
 * asterisk" out loud. Exported (in addition to being used by
 * `splitSentencesForTTS`) so the spoken-summary module can use the
 * same definition of "spoken length" when deciding whether to
 * summarize a long reply.
 */
export function stripMarkdownForSpeech(s: string): string {
  return (
    s
      // Code fences and inline code blocks read horribly aloud.
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/`[^`]+`/g, " ")
      // Headings / emphasis markers — keep the words, drop the punctuation.
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/(\*\*|__)([^*_]+)\1/g, "$2")
      .replace(/(\*|_)([^*_]+)\1/g, "$2")
      // List bullets at line start.
      .replace(/^\s*[-*+]\s+/gm, "")
      // Bare URLs and markdown links: keep the text, drop the URL.
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/https?:\/\/\S+/g, "")
      // Collapse whitespace.
      .replace(/\s+/g, " ")
      .trim()
  );
}
