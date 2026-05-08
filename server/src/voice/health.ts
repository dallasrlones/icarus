import { authHeaders, type VoiceConfig } from "./config.js";
import { readSettings } from "../storage/settings.js";

/**
 * Phase 15 — voice availability probe.
 *
 * The client polls this once at startup to decide whether to render
 * the floating mic button at all. Returns a combined view of the
 * STT and TTS upstreams without surfacing their full health
 * payloads (which leak model paths and CUDA details we don't need
 * the client to render).
 *
 * `available` is the conjunction of both upstreams reporting
 * healthy *and* the env URLs being set. Missing either URL ⇒
 * voice is feature-flagged off.
 *
 * Phase 19 — when `settings.voice.disabled` is true, the probe is
 * skipped entirely. This is the off-LAN escape hatch: instead of
 * eating a 4-second timeout per poll while traveling, the user
 * can flip the toggle and health goes unavailable instantly with
 * `disabled_by_user: true`. The mic button hides, voice POST
 * endpoints fast-fail with 503, and nothing tries to reach the
 * unreachable Orin until the user toggles back on.
 */

export interface VoiceHealth {
  available: boolean;
  /** Phase 19 — set when the user has explicitly disabled voice. */
  disabled_by_user?: boolean;
  stt: { ok: boolean; reason?: string; model?: string; device?: string };
  tts: { ok: boolean; reason?: string; voice?: string; sample_rate?: number };
}

/** XTTS / CUDA cold start can stall briefly before `/health` answers on-LAN. */
const PROBE_TIMEOUT_MS = 12_000;

async function probe(url: string, auth?: string): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const resp = await fetch(`${url.replace(/\/$/, "")}/health`, {
      signal: ctrl.signal,
      headers: authHeaders(auth),
    });
    if (!resp.ok) throw new Error(`upstream ${resp.status}`);
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function readVoiceHealth(cfg: VoiceConfig): Promise<VoiceHealth> {
  // Phase 19 — user-disabled short-circuit. Skip the upstream
  // probe entirely so we don't eat the 4s timeout when off-LAN.
  const settings = await readSettings();
  if (settings.voice.disabled) {
    return {
      available: false,
      disabled_by_user: true,
      stt: { ok: false, reason: "voice disabled by user" },
      tts: { ok: false, reason: "voice disabled by user" },
    };
  }

  const stt: VoiceHealth["stt"] = cfg.sttUrl
    ? await probe(cfg.sttUrl, cfg.sttAuth).then(
        (j) => {
          const data = j as { model?: string; device?: string };
          return {
            ok: true,
            model: data.model,
            device: data.device,
          };
        },
        (err) => ({ ok: false, reason: err instanceof Error ? err.message : String(err) }),
      )
    : { ok: false, reason: "VOICE_STT_URL not set" };

  const tts: VoiceHealth["tts"] = cfg.ttsUrl
    ? await probe(cfg.ttsUrl, cfg.ttsAuth).then(
        (j) => {
          const data = j as {
            default_voice?: string;
            sample_rate?: number;
            voices?: string[];
          };
          // Surface the *active* voice — fall back to the configured
          // default if the upstream doesn't echo one.
          const voice = cfg.ttsVoice ?? data.default_voice;
          // Guard against the common foot-gun: configured voice
          // doesn't exist in the upstream catalog.
          const catalog = Array.isArray(data.voices) ? data.voices : [];
          if (catalog.length > 0 && voice && !catalog.includes(voice)) {
            return {
              ok: false,
              reason: `voice "${voice}" missing from upstream catalog (${catalog.join(", ") || "empty"})`,
              voice,
              sample_rate: data.sample_rate,
            };
          }
          return {
            ok: true,
            voice,
            sample_rate: data.sample_rate,
          };
        },
        (err) => ({ ok: false, reason: err instanceof Error ? err.message : String(err) }),
      )
    : { ok: false, reason: "VOICE_TTS_URL not set" };

  return {
    available: stt.ok && tts.ok,
    stt,
    tts,
  };
}
