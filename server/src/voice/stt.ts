import { authHeaders, type VoiceConfig } from "./config.js";

/**
 * Phase 15 — STT proxy.
 *
 * Wraps the Jetson Orin `stt-service` (faster-whisper) behind a
 * single `transcribe` helper so callers can stay protocol-free.
 * The Orin endpoint is multipart/form-data with a `file` field;
 * we accept raw bytes + a content type from icarus's clients and
 * build the multipart on this side.
 *
 * Failure surface: any non-2xx from the Orin or a missing
 * `text` field becomes a thrown Error with an `httpStatus`
 * attached so the route layer can map it to an HTTP response.
 */

export interface TranscribeOptions {
  /** ISO code (en, es, fr, ...) — omit for auto-detect. */
  language?: string;
  /** "transcribe" (same language) or "translate" (to English). */
  task?: "transcribe" | "translate";
  /** Original filename — improves Orin's format detection. */
  filename?: string;
  /** Required so the Orin's parser can pick a decoder. */
  contentType: string;
}

export interface TranscribeResult {
  text: string;
  language: string;
  language_probability: number;
  duration: number;
  segments: unknown[];
}

export class VoiceProxyError extends Error {
  constructor(
    message: string,
    public readonly httpStatus: number,
    public readonly upstreamBody?: string,
  ) {
    super(message);
    this.name = "VoiceProxyError";
  }
}

export async function transcribe(
  cfg: VoiceConfig,
  audio: Uint8Array,
  opts: TranscribeOptions,
): Promise<TranscribeResult> {
  if (!cfg.sttUrl) {
    throw new VoiceProxyError("VOICE_STT_URL not configured", 503);
  }

  // Node's global FormData/Blob handle binary cleanly; faster-whisper
  // doesn't care about the filename beyond extension hints.
  const form = new FormData();
  const filename = opts.filename || guessFilename(opts.contentType);
  const blob = new Blob([audio as BlobPart], { type: opts.contentType });
  form.append("file", blob, filename);
  if (opts.language) form.append("language", opts.language);
  if (opts.task) form.append("task", opts.task);

  let resp: Response;
  try {
    resp = await fetch(`${cfg.sttUrl.replace(/\/$/, "")}/transcribe`, {
      method: "POST",
      body: form,
      headers: authHeaders(cfg.sttAuth),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new VoiceProxyError(`stt upstream unreachable: ${msg}`, 502);
  }

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new VoiceProxyError(`stt upstream ${resp.status}`, 502, body);
  }
  const data = (await resp.json()) as TranscribeResult;
  if (typeof data.text !== "string") {
    throw new VoiceProxyError("stt upstream returned no text", 502);
  }
  return data;
}

/**
 * Map content-types to filenames the Orin's whisper wrapper handles
 * cleanly. faster-whisper accepts wav/mp3/m4a/ogg/flac/webm — we
 * cover the formats both Expo's `expo-av` (m4a on iOS, m4a/3gp on
 * Android) and the web MediaRecorder (webm/ogg) emit.
 */
function guessFilename(contentType: string): string {
  const ct = contentType.toLowerCase();
  if (ct.includes("webm")) return "rec.webm";
  if (ct.includes("ogg")) return "rec.ogg";
  if (ct.includes("mp4") || ct.includes("m4a") || ct.includes("aac")) return "rec.m4a";
  if (ct.includes("mp3") || ct.includes("mpeg")) return "rec.mp3";
  if (ct.includes("wav") || ct.includes("pcm")) return "rec.wav";
  if (ct.includes("flac")) return "rec.flac";
  return "rec.bin";
}
