import { Platform } from "react-native";

/**
 * Phase 15 — push-to-talk recorder.
 *
 * Web-only for v1: uses the browser's `MediaRecorder` API. Native
 * (iOS/Android via Expo) is unsupported here; the voice button is
 * hidden on non-web platforms via `recorderSupported()` so users
 * never get a broken affordance. We can swap in `expo-audio` later
 * without touching call sites.
 *
 * Lifecycle:
 *   1. `start()` — request mic permission (cached after first
 *      grant), construct a MediaRecorder, begin recording.
 *   2. `stop()` — finalize the MediaRecorder and resolve with the
 *      recorded Blob + its content type (so the server proxy can
 *      label the multipart upload to faster-whisper).
 *   3. `cancel()` — stop without producing a Blob (used when the
 *      user releases mid-arm without intending to send).
 */

export interface RecordingResult {
  blob: Blob;
  contentType: string;
  /** Wall-clock duration in milliseconds — for "transcribing…" UX. */
  durationMs: number;
}

export function recorderSupported(): boolean {
  // RN-Web exposes window.MediaRecorder under web; native has no
  // window object at all. Some older browsers / iOS Safari < 14
  // ship without MediaRecorder; we treat those as unsupported.
  if (Platform.OS !== "web") return false;
  if (typeof window === "undefined") return false;
  // Silence TS: we know we're on web here.
  const w = window as unknown as { MediaRecorder?: unknown };
  return typeof w.MediaRecorder === "function";
}

/**
 * Pick the best mime type the browser supports. Order matters:
 * Whisper handles webm/ogg/m4a/wav/mp3, so preference goes to the
 * smallest formats first. Falls back to the browser's default if
 * none of our candidates are accepted.
 */
function pickMimeType(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const MR = (window as unknown as { MediaRecorder?: { isTypeSupported?: (t: string) => boolean } })
    .MediaRecorder;
  if (!MR || typeof MR.isTypeSupported !== "function") return undefined;
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/ogg",
    "audio/mp4",
  ];
  for (const c of candidates) {
    if (MR.isTypeSupported(c)) return c;
  }
  return undefined;
}

/**
 * Single-recording controller. We don't persist anything between
 * starts — each `start()` reuses the cached `MediaStream` (saves
 * the permission round-trip) but builds a fresh MediaRecorder.
 */
export class WebRecorder {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: BlobPart[] = [];
  private startedAt = 0;
  private mimeType: string | undefined;

  isRecording(): boolean {
    return this.recorder?.state === "recording";
  }

  /**
   * Acquire mic + start. Idempotent if already recording (resolves
   * immediately with no-op). Throws on permission denial.
   */
  async start(): Promise<void> {
    if (!recorderSupported()) throw new Error("recorder not supported on this platform");
    if (this.isRecording()) return;

    if (!this.stream) {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          // 16kHz mono is whisper's native rate; the browser may
          // ignore these but they're hints worth giving.
          sampleRate: 16_000,
          channelCount: 1,
        },
      });
    }

    this.mimeType = pickMimeType();
    const recorder = new (window as unknown as { MediaRecorder: typeof MediaRecorder }).MediaRecorder(
      this.stream,
      this.mimeType ? { mimeType: this.mimeType } : undefined,
    );
    this.recorder = recorder;
    this.chunks = [];
    recorder.ondataavailable = (ev: BlobEvent) => {
      if (ev.data && ev.data.size > 0) this.chunks.push(ev.data);
    };
    this.startedAt = Date.now();
    recorder.start();
  }

  /**
   * Finalize the recording. Resolves with the captured audio. If
   * there's no active recorder (or it produced no audio), throws —
   * callers should treat that as a no-op (e.g., button armed but
   * nothing recorded).
   */
  async stop(): Promise<RecordingResult> {
    const recorder = this.recorder;
    if (!recorder) throw new Error("no active recording");
    const durationMs = Date.now() - this.startedAt;

    return await new Promise<RecordingResult>((resolve, reject) => {
      recorder.onstop = () => {
        try {
          const contentType = this.mimeType ?? recorder.mimeType ?? "audio/webm";
          const blob = new Blob(this.chunks, { type: contentType });
          this.recorder = null;
          this.chunks = [];
          if (blob.size === 0) {
            reject(new Error("empty recording"));
            return;
          }
          resolve({ blob, contentType, durationMs });
        } catch (err) {
          reject(err);
        }
      };
      try {
        recorder.stop();
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Stop and discard. We still call MediaRecorder.stop() to release
   * the input stream; the resulting Blob is dropped.
   */
  cancel(): void {
    const recorder = this.recorder;
    if (!recorder) return;
    recorder.onstop = null;
    try {
      recorder.stop();
    } catch {
      /* ignore */
    }
    this.recorder = null;
    this.chunks = [];
  }

  /**
   * Release the cached MediaStream — the next `start()` will
   * re-prompt for permission. Useful when the user explicitly
   * disables voice mode.
   */
  release(): void {
    this.cancel();
    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        try {
          track.stop();
        } catch {
          /* ignore */
        }
      }
      this.stream = null;
    }
  }
}
