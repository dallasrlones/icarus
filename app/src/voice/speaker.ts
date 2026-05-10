import { Platform } from "react-native";
import { apiBaseUrl } from "../baseUrl";
import { authFetch } from "../auth";

/**
 * Phase 15 — TTS playback queue.
 *
 * Streams the assistant's reply through the icarus-server voice
 * proxy a sentence at a time. We `splitSentencesForTTS` (server
 * helper) on the running text every time more streams in, fetch
 * audio for each sentence, and play sequentially via **Web Audio**
 * (`decodeAudioData` + buffer sources) when available — mobile
 * Safari handles that better than `<audio>` blob playback after
 * async work — with `<audio>` as a fallback.
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

/** Reused so repeated taps don't allocate endless AudioContexts. */
let primedAudioCtx: AudioContext | null = null;

/**
 * iOS Safari (and strict mobile WebKit) often refuses `HTMLAudioElement.play()`
 * when it runs *after* awaits/network — even if the mic was opened from the same
 * tap flow. Call this **synchronously** from push-to-talk / send / speak handlers
 * (before any `await`) so output is allowed for the rest of the session.
 */
export function primeMobilePlaybackFromUserGesture(): void {
  if (!speakerSupported()) return;
  try {
    const W = window as typeof window & { webkitAudioContext?: typeof AudioContext };
    const AC = window.AudioContext ?? W.webkitAudioContext;
    if (AC) {
      if (!primedAudioCtx || primedAudioCtx.state === "closed") {
        primedAudioCtx = new AC();
      }
      void primedAudioCtx.resume();
      const buf = primedAudioCtx.createBuffer(1, 1, 22050);
      const src = primedAudioCtx.createBufferSource();
      src.buffer = buf;
      src.connect(primedAudioCtx.destination);
      src.start(0);
    }
  } catch {
    /* non-fatal — desktop ignores */
  }

  try {
    // Second path: prime the same `<audio>` stack we use for TTS blobs.
    const silent =
      "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA";
    const primed = new Audio(silent);
    primed.volume = 0.0001;
    primed.preload = "auto";
    primed.setAttribute("playsinline", "");
    (primed as HTMLAudioElement & { playsInline?: boolean }).playsInline = true;
    void primed.play().catch(() => {});
  } catch {
    /* ignore */
  }
}

interface QueueEntry {
  text: string;
  blob: Blob;
  /** Generation captured when the chunk was enqueued — stale chunks skip after cancel(). */
  gen: number;
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

async function fetchSpeechBlob(text: string): Promise<Blob> {
  const res = await authFetch(`${apiBaseUrl()}/v1/voice/synthesize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`synthesize ${res.status}: ${body.slice(0, 200)}`);
  }
  return await res.blob();
}


export class TTSPlayer {
  private spokenChunks = new Set<string>();
  private queue: QueueEntry[] = [];
  private playing = false;
  /** Active Web Audio source — stopped on `cancel()` so interruption works. */
  private currentBufferSource: AudioBufferSourceNode | null = null;
  /** Fallback `<audio>` element currently playing (if any). */
  private currentHtmlAudio: HTMLAudioElement | null = null;
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
        const blob = await fetchSpeechBlob(chunk);
        if (myGen !== this.generation) return;
        this.queue.push({ text: chunk, blob, gen: myGen });
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
    try {
      this.currentBufferSource?.stop();
    } catch {
      /* already stopped */
    }
    this.currentBufferSource = null;
    try {
      this.currentHtmlAudio?.pause();
    } catch {
      /* ignore */
    }
    this.currentHtmlAudio = null;
    this.active = false;
    this.currentText = "";
    this.spokenChunks.clear();
    this.queue = [];
    this.playing = false;
  }

  private getPlaybackContext(): AudioContext | null {
    if (!speakerSupported()) return null;
    try {
      const W = window as typeof window & { webkitAudioContext?: typeof AudioContext };
      const AC = window.AudioContext ?? W.webkitAudioContext;
      if (!AC) return null;
      if (!primedAudioCtx || primedAudioCtx.state === "closed") {
        primedAudioCtx = new AC();
      }
      return primedAudioCtx;
    } catch {
      return null;
    }
  }

  /**
   * Prefer Web Audio (`decodeAudioData` + buffer source): iOS Safari often blocks
   * `HTMLAudioElement.play()` on blob URLs after network/async gaps even when
   * the mic was opened from a tap; playback through an AudioContext primed in
   * the same gesture tends to succeed for the whole session.
   */
  private async playBlob(blob: Blob, gen: number): Promise<void> {
    const ctx = this.getPlaybackContext();
    if (ctx) {
      try {
        await ctx.resume();
        const raw = await blob.arrayBuffer();
        if (gen !== this.generation) return;
        const audioBuf = await ctx.decodeAudioData(raw.slice(0));
        if (gen !== this.generation) return;
        await new Promise<void>((resolve) => {
          const src = ctx.createBufferSource();
          this.currentBufferSource = src;
          src.buffer = audioBuf;
          src.connect(ctx.destination);
          src.onended = () => {
            if (this.currentBufferSource === src) this.currentBufferSource = null;
            resolve();
          };
          src.start(0);
        });
        return;
      } catch (err) {
        console.error("[voice] Web Audio playback failed:", err);
        try {
          this.currentBufferSource?.stop();
        } catch {
          /* ignore */
        }
        this.currentBufferSource = null;
      }
    }

    const url = URL.createObjectURL(blob);
    try {
      const audio = new Audio(url);
      this.currentHtmlAudio = audio;
      audio.preload = "auto";
      audio.volume = 1;
      audio.setAttribute("playsinline", "");
      (audio as HTMLAudioElement & { playsInline?: boolean }).playsInline = true;
      await new Promise<void>((resolve) => {
        audio.onended = () => resolve();
        audio.onerror = () => resolve();
        void audio.play().catch((e) => {
          console.error("[voice] audio.play failed:", e);
          resolve();
        });
      });
    } finally {
      this.currentHtmlAudio = null;
      URL.revokeObjectURL(url);
    }
  }

  private async drain(): Promise<void> {
    if (this.playing) return;
    this.playing = true;
    try {
      while (this.queue.length > 0) {
        const entry = this.queue.shift()!;
        if (entry.gen !== this.generation) continue;
        await this.playBlob(entry.blob, entry.gen);
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
