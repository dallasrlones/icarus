import { readJsonOr, writeJson } from "./json.js";
import { settingsFile } from "./paths.js";

/**
 * Phase 19 — global runtime settings.
 *
 * Single JSON file at `store/settings.json`. Today it holds one
 * field (`voice.disabled`) but the shape is intentionally a tree
 * so future runtime toggles (queue auto-start, council
 * aggressiveness, telemetry, etc.) can land here without a
 * separate file each.
 *
 * Reads always shape-complete the settings object via
 * `withDefaults` — callers never see `undefined` for a field they
 * just added in the latest version of the server. Writes go
 * through `writeJson` (atomic temp-rename) so a crash mid-write
 * can't leave a half-truncated file on disk.
 *
 * Why settings live OUTSIDE the slug-dir tree (alongside fleet
 * and global activity instead of under a project) — these are
 * cross-project knobs. A user toggling voice off doesn't want to
 * have to flip it for each project.
 */

export interface Settings {
  voice: {
    /**
     * When true, voice features are hard-disabled. The health
     * endpoint short-circuits to unhealthy without probing the
     * upstreams (no 4-second LAN timeout when you're on the
     * road), and all voice POST endpoints return 503.
     */
    disabled: boolean;
    /**
     * Phase 21 — runtime-editable voice provider endpoints.
     *
     * Each field overrides the matching env var (`VOICE_STT_URL`,
     * `VOICE_TTS_URL`, `VOICE_TTS_VOICE`, `VOICE_TTS_LANGUAGE`)
     * when non-empty. This lets users hot-swap to a different STT
     * or TTS provider (third-party or self-hosted) without editing
     * `.env` and restarting the server. Empty fields fall back to
     * env, then to the icarus defaults.
     *
     * `auth` is sent as a `Authorization: Bearer <auth>` header on
     * every upstream request. Use it for providers that gate behind
     * an API key. Stored in plaintext in `store/settings.json` —
     * treat the data root as you would `.env`.
     *
     * Compatibility: the upstream URL is expected to speak the icarus
     * voice contract documented in `docs/VOICE.md` (`GET /health`,
     * `POST /transcribe`, `POST /synthesize`). For providers that
     * don't natively speak the contract (OpenAI Whisper, ElevenLabs,
     * etc.), wrap them in a thin proxy.
     */
    stt: {
      url: string;
      auth: string;
    };
    tts: {
      url: string;
      auth: string;
      voice: string;
      language: string;
    };
  };
  /**
   * Phase 20 — per-role cursor-agent model selection.
   *
   * `chat` is used for user-facing conversational turns:
   *   - global / per-project chat handlers (`ChatStore`)
   *   - voice "spoken summary" rewrite (`computeSpokenForText`)
   * `agent` is used for autonomous decision-making paths:
   *   - queue worker (task execution)
   *   - council runs (lens reviews + chair synthesis)
   *   - tool runs (which dispatch through the queue worker)
   *
   * Either may be the empty string, in which case we fall back to
   * the legacy `CURSOR_MODEL` env (or cursor-agent's CLI default
   * if that's also unset). The empty default keeps existing
   * deployments working unchanged after upgrade.
   */
  models: {
    chat: string;
    agent: string;
  };
}

/**
 * Defaults shipped with a fresh install. `composer-2` is cheap and
 * fast for chat; `claude-opus-4.7` is the heaviest reasoning model
 * available, which is what you want for the autonomous queue's
 * decisions and the council's verdicts. Both can be flipped in the
 * UI's Settings tab without restarting the server.
 */
const DEFAULTS: Settings = {
  voice: {
    disabled: false,
    stt: { url: "", auth: "" },
    tts: { url: "", auth: "", voice: "", language: "" },
  },
  models: { chat: "composer-2", agent: "claude-opus-4.7" },
};

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function withDefaults(partial: Partial<Settings> | null | undefined): Settings {
  const v = partial?.voice ?? {};
  return {
    voice: {
      disabled: Boolean((v as { disabled?: boolean }).disabled),
      stt: {
        url: str((v as { stt?: { url?: string } }).stt?.url),
        auth: str((v as { stt?: { auth?: string } }).stt?.auth),
      },
      tts: {
        url: str((v as { tts?: { url?: string } }).tts?.url),
        auth: str((v as { tts?: { auth?: string } }).tts?.auth),
        voice: str((v as { tts?: { voice?: string } }).tts?.voice),
        language: str((v as { tts?: { language?: string } }).tts?.language),
      },
    },
    models: {
      chat:
        typeof partial?.models?.chat === "string" && partial.models.chat.length > 0
          ? partial.models.chat
          : DEFAULTS.models.chat,
      agent:
        typeof partial?.models?.agent === "string" && partial.models.agent.length > 0
          ? partial.models.agent
          : DEFAULTS.models.agent,
    },
  };
}

export async function readSettings(): Promise<Settings> {
  const raw = await readJsonOr<Partial<Settings>>(settingsFile(), {});
  return withDefaults(raw);
}

export async function writeSettings(next: Settings): Promise<void> {
  await writeJson(settingsFile(), next);
}

export async function patchVoiceSettings(patch: { disabled?: boolean }): Promise<Settings> {
  const current = await readSettings();
  const next: Settings = {
    ...current,
    voice: {
      ...current.voice,
      ...patch,
    },
  };
  await writeSettings(next);
  return next;
}

/**
 * Phase 21 — patch the voice endpoint config (URL / auth / voice
 * catalog name / language). Each field is independent: a missing
 * field leaves the current value untouched, an empty string clears
 * it (so the env-var fallback wins).
 *
 * Auth fields are *write-only* in the read API (`GET /v1/settings/voice`
 * returns "***" when set). They live in `store/settings.json` in
 * plaintext, so treat the data root with the same care as `.env`.
 */
export async function patchVoiceEndpoints(patch: {
  stt_url?: string;
  stt_auth?: string;
  tts_url?: string;
  tts_auth?: string;
  voice?: string;
  language?: string;
}): Promise<Settings> {
  const current = await readSettings();
  const next: Settings = {
    ...current,
    voice: {
      ...current.voice,
      stt: {
        url: patch.stt_url !== undefined ? patch.stt_url : current.voice.stt.url,
        auth: patch.stt_auth !== undefined ? patch.stt_auth : current.voice.stt.auth,
      },
      tts: {
        url: patch.tts_url !== undefined ? patch.tts_url : current.voice.tts.url,
        auth: patch.tts_auth !== undefined ? patch.tts_auth : current.voice.tts.auth,
        voice: patch.voice !== undefined ? patch.voice : current.voice.tts.voice,
        language: patch.language !== undefined ? patch.language : current.voice.tts.language,
      },
    },
  };
  await writeSettings(next);
  return next;
}

/**
 * Patch model selections. Empty strings are interpreted as "reset
 * to default" (replaced by `withDefaults` on next read), so the
 * UI's "(default)" option can pass `""` rather than the literal
 * default slug — the user sees a stable "(default)" label even if
 * we change which slug ships as default in a future release.
 */
export async function patchModelSettings(patch: {
  chat?: string;
  agent?: string;
}): Promise<Settings> {
  const current = await readSettings();
  const next: Settings = {
    ...current,
    models: {
      chat: patch.chat !== undefined ? patch.chat : current.models.chat,
      agent: patch.agent !== undefined ? patch.agent : current.models.agent,
    },
  };
  await writeSettings(next);
  return next;
}

/**
 * Resolve the model slug to pass to `cursor-agent --model` for a
 * given role. Reads settings on every call so flipping the model
 * in the UI takes effect immediately, with no in-memory cache to
 * invalidate. Returns `undefined` if no model has been chosen for
 * this role and `CURSOR_MODEL` is also unset — caller passes
 * `undefined` to cursor-agent and the CLI picks its own default.
 */
export async function modelFor(
  role: "chat" | "agent",
  envFallback: string | undefined,
): Promise<string | undefined> {
  const s = await readSettings();
  const chosen = s.models[role];
  if (chosen && chosen.length > 0) return chosen;
  return envFallback || undefined;
}
