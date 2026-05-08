import { readSettings } from "../storage/settings.js";

/**
 * Phase 15 / 21 — voice proxy config.
 *
 * Resolved on every request from two layers (settings wins):
 *
 *   1. `store/settings.json` — runtime-editable from the Settings
 *      tab. Lets users hot-swap STT/TTS providers without
 *      restarting the server. Auth tokens live here in plaintext.
 *   2. Environment variables (`VOICE_STT_URL`, `VOICE_TTS_URL`,
 *      `VOICE_TTS_VOICE`, `VOICE_TTS_LANGUAGE`) — the
 *      "first-install / 12-factor" path for ops.
 *
 * Both unset ⇒ voice is feature-flagged off; `isVoiceEnabled`
 * returns false, the health probe reports unavailable, and POST
 * endpoints return 503. The mic button never renders.
 *
 * Compatibility: the configured URLs must speak the icarus voice
 * contract (see `docs/VOICE.md`). For providers that don't, wrap
 * them in a thin proxy that does — the contract is intentionally
 * minimal (3 endpoints).
 *
 * The voice proxy *only* runs as a relay — no audio is buffered
 * to disk, no transcripts persist outside chat history. We pass
 * audio bytes straight through, return WAV bytes straight back.
 */

export interface VoiceConfig {
  sttUrl?: string;
  /** Bearer token sent as `Authorization: Bearer <auth>` to STT. */
  sttAuth?: string;
  ttsUrl?: string;
  /** Bearer token sent as `Authorization: Bearer <auth>` to TTS. */
  ttsAuth?: string;
  /** Default voice clip on the TTS side (catalog name, no extension). */
  ttsVoice: string;
  /** Default language code (ISO short form). */
  ttsLanguage: string;
  /**
   * Provenance flags so the Settings UI can show "(env)" vs
   * "(custom)" badges next to each field. Lets the user see at a
   * glance whether they're running on the shipped defaults or an
   * override they typed in.
   */
  source: {
    stt: "settings" | "env" | "unset";
    tts: "settings" | "env" | "unset";
  };
}

/**
 * Read voice config from settings.json with env-var fallback.
 * Async because settings.json is on disk; called per-request which
 * keeps it real-time without an in-memory cache to invalidate.
 */
export async function readVoiceConfig(): Promise<VoiceConfig> {
  const envStt = process.env.VOICE_STT_URL || "";
  const envTts = process.env.VOICE_TTS_URL || "";
  const envVoice = process.env.VOICE_TTS_VOICE || "";
  const envLang = process.env.VOICE_TTS_LANGUAGE || "";

  const s = await readSettings();
  const stt = s.voice.stt;
  const tts = s.voice.tts;

  const sttUrl = stt.url || envStt;
  const ttsUrl = tts.url || envTts;

  return {
    sttUrl: sttUrl || undefined,
    sttAuth: stt.auth || undefined,
    ttsUrl: ttsUrl || undefined,
    ttsAuth: tts.auth || undefined,
    ttsVoice: tts.voice || envVoice || "default",
    ttsLanguage: tts.language || envLang || "en",
    source: {
      stt: stt.url ? "settings" : envStt ? "env" : "unset",
      tts: tts.url ? "settings" : envTts ? "env" : "unset",
    },
  };
}

/** Synchronous variant kept for legacy callers; prefer the async form. */
export function readVoiceConfigEnvOnly(): VoiceConfig {
  const envStt = process.env.VOICE_STT_URL || "";
  const envTts = process.env.VOICE_TTS_URL || "";
  return {
    sttUrl: envStt || undefined,
    ttsUrl: envTts || undefined,
    ttsVoice: process.env.VOICE_TTS_VOICE || "default",
    ttsLanguage: process.env.VOICE_TTS_LANGUAGE || "en",
    source: { stt: envStt ? "env" : "unset", tts: envTts ? "env" : "unset" },
  };
}

export function isVoiceEnabled(cfg: VoiceConfig): boolean {
  return Boolean(cfg.sttUrl) && Boolean(cfg.ttsUrl);
}

/**
 * Build the headers for an outbound request to the configured
 * upstream. Includes `Authorization: Bearer <token>` only when
 * auth is set; we never send an empty bearer.
 */
export function authHeaders(token?: string): Record<string, string> {
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}
