import { Platform } from "react-native";
import { apiBaseUrl } from "../baseUrl";
import { authFetch } from "../auth";

/**
 * Phase 15 — TTS playback queue.
 *
 * Streams the assistant's reply through the icarus-server voice
 * proxy a sentence at a time. We `splitSentencesForTTS` (server
 * helper) on the running text every time more streams in, fetch
 * the WAV for any new sentences, and play them sequentially using
 * the browser's HTMLAudioElement.
 *
 * Why server-side splitting: the splitter strips markdown noise
 * (code fences, bullets, URLs) so the TTS doesn't read "asterisk
 * asterisk" out loud. Putting the logic on the server means the
 * client doesn't carry a markdown stripper.
 *
 * Web-only for v1, mirrors `recorder.ts` — `speakerSupported()`
 * gates the UI.
 */

export function speakerSupported(): boolean {
  if (Platform.OS !== "web") return false;
  if (typeof window === "undefined") return false;
  const w = window as unknown as { Audio?: unknown };
  return typeof w.Audio === "function";
}

interface QueueEntry {
  text: string;
  audio: HTMLAudioElement;
  blobUrl: string;
}

/**
 * Splits a running text into sentence-sized chunks via the server.
 * The server helper is pure (no LLM), so this is cheap.
 */
async function splitSentences(text: string, maxChars = 240): Promise<string[]> {
  const res = await authFetch(`${apiBaseUrl()}/v1/voice/split_sentences`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, max_chars: maxChars }),
  });
  if (!res.ok) throw new Error(`split_sentences ${res.status}`);
  const data = (await res.json()) as { chunks: string[] };
  return Array.isArray(data.chunks) ? data.chunks : [];
}

async function fetchSpeechAudio(text: string): Promise<HTMLAudioElement & { _blobUrl: string }> {
  // The `<audio>` element loads the audio URL itself (not via fetch),
  // so it can't pin our Authorization header. We resolve the
  // playback URL by hitting `/v1/voice/synthesize` with `authFetch`,
  // grabbing the response as a Blob, then handing the Blob URL to
  // `<audio>`. That way the upstream auth check happens on the
  // proxy POST, not on the playback GET (which never happens).
  const res = await authFetch(`${apiBaseUrl()}/v1/voice/synthesize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`synthesize ${res.status}: ${body.slice(0, 200)}`);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url) as HTMLAudioElement & { _blobUrl: string };
  audio._blobUrl = url;
  audio.preload = "auto";
  return audio;
}


export class TTSPlayer {
  private spokenChunks = new Set<string>();
  private queue: QueueEntry[] = [];
  private playing = false;
  /** Set true while the player is actively pulling new chunks. */
  private active = false;
  /** Latest streaming text the caller has fed us. */
  private currentText = "";
  /** Bumped on each `cancel` so in-flight fetches can detect they're stale. */
  private generation = 0;
  /**
   * Optional callback fired exactly once each time the queue drains
   * back to empty (i.e. the assistant's reply has finished playing).
   * Used by the store to flip the voice UI back to "idle".
   */
  private onIdleCallback: (() => void) | null = null;

  /** Register an idle callback. Replaces any previous callback. */
  onIdle(cb: (() => void) | null): void {
    this.onIdleCallback = cb;
  }

  isActive(): boolean {
    return this.active;
  }

  /**
   * Generation counter — bumped every `cancel()`. Callers that
   * await an async step (e.g. fetching a spoken-summary from the
   * server) before feeding the speaker can capture this at the
   * start and re-check after the await: if the user re-armed the
   * mic mid-fetch, generation will have advanced and the caller
   * should drop the stale audio rather than play over the new
   * recording session.
   */
  getGeneration(): number {
    return this.generation;
  }

  /**
   * Begin/continue speaking the assistant's running reply. Safe to
   * call repeatedly as the assistant streams more text — only new
   * sentences are fetched + played.
   */
  async update(text: string): Promise<void> {
    if (!speakerSupported()) return;
    this.active = true;
    this.currentText = text;
    const myGen = this.generation;
    let chunks: string[];
    try {
      chunks = await splitSentences(text);
    } catch (err) {
      // Soft fail: don't crash the chat stream. Log + bail.
      console.error("[voice] split_sentences failed:", err);
      return;
    }
    if (myGen !== this.generation) return;

    for (const chunk of chunks) {
      if (this.spokenChunks.has(chunk)) continue;
      this.spokenChunks.add(chunk);
      try {
        const audio = await fetchSpeechAudio(chunk);
        if (myGen !== this.generation) {
          // Cancellation snuck in — release the URL we just made and bail.
          URL.revokeObjectURL(audio._blobUrl);
          return;
        }
        this.queue.push({ text: chunk, audio, blobUrl: audio._blobUrl });
        void this.drain();
      } catch (err) {
        console.error("[voice] synthesize failed for chunk:", err);
        // Keep going — partial speech is better than silence.
      }
    }
  }

  /**
   * Mark the assistant turn finished. Lets the queue drain naturally
   * once all queued chunks have played; future `update()` calls (for
   * a *new* assistant turn) start fresh after `cancel()`.
   */
  finalize(): void {
    // Nothing to do — chunks already in the queue continue to play.
    // The `active` flag flips off when the queue empties in `drain`.
  }

  /**
   * Stop everything immediately. Used when:
   *   - The user starts a new utterance (don't talk over yourself).
   *   - The assistant turn ends and a typed turn follows.
   */
  cancel(): void {
    this.generation++;
    this.active = false;
    this.currentText = "";
    this.spokenChunks.clear();
    for (const entry of this.queue) {
      try {
        entry.audio.pause();
      } catch {
        /* ignore */
      }
      URL.revokeObjectURL(entry.blobUrl);
    }
    this.queue = [];
    this.playing = false;
  }

  private async drain(): Promise<void> {
    if (this.playing) return;
    this.playing = true;
    try {
      while (this.queue.length > 0) {
        const entry = this.queue.shift()!;
        await new Promise<void>((resolve) => {
          entry.audio.onended = () => resolve();
          entry.audio.onerror = () => resolve();
          entry.audio
            .play()
            .catch((err) => {
              console.error("[voice] audio.play failed:", err);
              resolve();
            });
        });
        URL.revokeObjectURL(entry.blobUrl);
      }
    } finally {
      this.playing = false;
      // If nothing more is being fed and the queue is drained,
      // mark inactive so the UI's "speaking" state clears.
      if (this.queue.length === 0) {
        this.active = false;
        const cb = this.onIdleCallback;
        if (cb) {
          try {
            cb();
          } catch (err) {
            console.error("[voice] onIdle callback threw:", err);
          }
        }
      }
    }
  }
}
