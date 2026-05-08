import type {
  ActivityEntry,
  Architecture,
  Chat,
  ChatScope,
  ChatSummary,
  CouncilRun,
  CouncilRunType,
  CronJob,
  Feature,
  Flow,
  Message,
  Pill,
  ProjectDetail,
  Persona,
  ProjectListing,
  Question,
  QueueSnapshot,
  ResolvedPersona,
  Rule,
  Task,
  Tool,
  ToolProposal,
} from "./types";
import { authFetch } from "./auth";

const FALLBACK_API = "http://localhost:4000";

/**
 * Resolve API base URL. `EXPO_PUBLIC_API_URL` is the canonical override (works
 * on web + native). On web we additionally fall back to same-origin :4000 so a
 * dockerized frontend served on a non-localhost host still hits the backend.
 */
export function apiBaseUrl(): string {
  const fromEnv = process.env.EXPO_PUBLIC_API_URL;
  if (fromEnv && fromEnv.length > 0) return fromEnv.replace(/\/$/, "");
  if (typeof window !== "undefined" && window.location?.hostname) {
    return `${window.location.protocol}//${window.location.hostname}:4000`;
  }
  return FALLBACK_API;
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}: ${body}`);
  }
  return (await res.json()) as T;
}

function scopePath(scope: ChatScope): string {
  return scope.kind === "global" ? "" : `/projects/${encodeURIComponent(scope.slug)}`;
}

// ---- Chat (scope-aware) ----

export async function listChats(scope: ChatScope): Promise<ChatSummary[]> {
  const res = await authFetch(`${apiBaseUrl()}${scopePath(scope)}/chats`);
  const body = await jsonOrThrow<{ chats: ChatSummary[] }>(res);
  return body.chats;
}

export async function createChat(scope: ChatScope): Promise<Chat> {
  const res = await authFetch(`${apiBaseUrl()}${scopePath(scope)}/chats`, { method: "POST" });
  const body = await jsonOrThrow<{ chat: Chat }>(res);
  return body.chat;
}

export async function getChat(scope: ChatScope, id: string): Promise<Chat> {
  const res = await authFetch(`${apiBaseUrl()}${scopePath(scope)}/chats/${id}`);
  const body = await jsonOrThrow<{ chat: Chat }>(res);
  return body.chat;
}

export async function deleteChat(scope: ChatScope, id: string): Promise<void> {
  const res = await authFetch(`${apiBaseUrl()}${scopePath(scope)}/chats/${id}`, { method: "DELETE" });
  if (!res.ok && res.status !== 404) {
    throw new Error(`failed to delete chat: ${res.status}`);
  }
}

export interface SendCallbacks {
  onChunk: (delta: string) => void;
  onPill?: (pill: Pill) => void;
  onRetryStatus?: (info: { phase: "retrying" | "exhausted"; attempt: number; rejections: number }) => void;
  onDone: (payload: { user: Message; assistant: Message }) => void;
  onError: (message: string) => void;
}

/**
 * POST /<scope>/chats/:id/messages and parse the SSE response stream.
 *
 * Hand-rolled because EventSource doesn't support POST bodies and isn't
 * universally available across React Native runtimes; `fetch` + `ReadableStream`
 * works on web, Hermes (RN 0.76+), and modern Node.
 */
export async function sendMessage(
  scope: ChatScope,
  chatId: string,
  text: string,
  cb: SendCallbacks,
  signal?: AbortSignal,
  /**
   * Phase 15 — opaque per-tab id so agent-emitted `navigate`
   * mutations can route their WS event to the originating client.
   * Optional; the server falls back to broadcasting to everyone.
   */
  clientId?: string,
): Promise<void> {
  const res = await authFetch(`${apiBaseUrl()}${scopePath(scope)}/chats/${chatId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({ text, ...(clientId ? { client_id: clientId } : {}) }),
    signal,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}: ${body}`);
  }
  if (!res.body) {
    throw new Error("response body is empty (streaming unsupported on this runtime)");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const handleEvent = (rawEvent: string) => {
    let eventName = "message";
    const dataLines: string[] = [];
    for (const line of rawEvent.split("\n")) {
      if (line.startsWith("event:")) eventName = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length === 0) return;
    let data: unknown;
    try {
      data = JSON.parse(dataLines.join("\n"));
    } catch {
      return;
    }
    if (eventName === "chunk" && data && typeof (data as { delta?: unknown }).delta === "string") {
      cb.onChunk((data as { delta: string }).delta);
    } else if (eventName === "pill") {
      cb.onPill?.(data as Pill);
    } else if (eventName === "retry_status") {
      cb.onRetryStatus?.(data as { phase: "retrying" | "exhausted"; attempt: number; rejections: number });
    } else if (eventName === "done") {
      cb.onDone(data as { user: Message; assistant: Message });
    } else if (eventName === "error") {
      cb.onError((data as { message?: string }).message ?? "unknown error");
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) >= 0) {
      const rawEvent = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      if (rawEvent.length > 0) handleEvent(rawEvent);
    }
  }
}

// ---- Projects ----

export async function listProjects(includeArchived = false): Promise<ProjectListing[]> {
  const url = `${apiBaseUrl()}/projects${includeArchived ? "?include_archived=1" : ""}`;
  const res = await authFetch(url);
  const body = await jsonOrThrow<{ projects: ProjectListing[] }>(res);
  return body.projects;
}

export async function getProject(slug: string): Promise<ProjectDetail> {
  const res = await authFetch(`${apiBaseUrl()}/projects/${encodeURIComponent(slug)}`);
  return await jsonOrThrow<ProjectDetail>(res);
}

export async function getProjectActivity(slug: string, limit = 50): Promise<ActivityEntry[]> {
  const res = await authFetch(
    `${apiBaseUrl()}/projects/${encodeURIComponent(slug)}/activity?limit=${limit}`,
  );
  const body = await jsonOrThrow<{ entries: ActivityEntry[] }>(res);
  return body.entries;
}

// ---- Features / Flows / Tasks ----

export async function listFeatures(slug: string): Promise<Feature[]> {
  const res = await authFetch(`${apiBaseUrl()}/projects/${encodeURIComponent(slug)}/features`);
  const body = await jsonOrThrow<{ features: Feature[] }>(res);
  return body.features;
}

export async function listFlows(slug: string): Promise<Flow[]> {
  const res = await authFetch(`${apiBaseUrl()}/projects/${encodeURIComponent(slug)}/flows`);
  const body = await jsonOrThrow<{ flows: Flow[] }>(res);
  return body.flows;
}

export async function getFlow(slug: string, featureId: string): Promise<Flow> {
  const res = await authFetch(
    `${apiBaseUrl()}/projects/${encodeURIComponent(slug)}/flows/${encodeURIComponent(featureId)}`,
  );
  const body = await jsonOrThrow<{ flow: Flow }>(res);
  return body.flow;
}

export async function listTasks(slug: string): Promise<Task[]> {
  const res = await authFetch(`${apiBaseUrl()}/projects/${encodeURIComponent(slug)}/tasks`);
  const body = await jsonOrThrow<{ tasks: Task[] }>(res);
  return body.tasks;
}

// ---- Council ----

export async function listCouncilRuns(
  slug: string,
  featureId: string,
  type?: CouncilRunType,
): Promise<CouncilRun[]> {
  const qs = type ? `?type=${encodeURIComponent(type)}` : "";
  const res = await authFetch(
    `${apiBaseUrl()}/projects/${encodeURIComponent(slug)}/council/${encodeURIComponent(featureId)}${qs}`,
  );
  const body = await jsonOrThrow<{ runs: CouncilRun[] }>(res);
  return body.runs;
}

export async function getCouncilRun(
  slug: string,
  featureId: string,
  runType: CouncilRunType,
  runId: string,
): Promise<CouncilRun> {
  const res = await authFetch(
    `${apiBaseUrl()}/projects/${encodeURIComponent(slug)}/council/${encodeURIComponent(
      featureId,
    )}/${encodeURIComponent(runType)}/${encodeURIComponent(runId)}`,
  );
  const body = await jsonOrThrow<{ run: CouncilRun }>(res);
  return body.run;
}

// ---- Architecture (Phase 8) ----

export async function getArchitecture(slug: string): Promise<Architecture> {
  const res = await authFetch(
    `${apiBaseUrl()}/projects/${encodeURIComponent(slug)}/architecture`,
  );
  const body = await jsonOrThrow<{ architecture: Architecture }>(res);
  return body.architecture;
}

// ---- Code browser ----

export interface CodeFileEntry {
  name: string;
  rel_path: string;
  kind: "dir" | "file";
  size?: number;
}

export interface CodeListing {
  rel_path: string;
  entries: CodeFileEntry[];
}

export async function listFiles(slug: string, relPath = ""): Promise<CodeListing> {
  const qs = relPath ? `?path=${encodeURIComponent(relPath)}` : "";
  const res = await authFetch(
    `${apiBaseUrl()}/projects/${encodeURIComponent(slug)}/files${qs}`,
  );
  return await jsonOrThrow<CodeListing>(res);
}

export interface CodeFile {
  rel_path: string;
  size: number;
  truncated: boolean;
  binary: boolean;
  language?: string;
  text?: string;
}

export async function readFile(slug: string, relPath: string): Promise<CodeFile> {
  const res = await authFetch(
    `${apiBaseUrl()}/projects/${encodeURIComponent(slug)}/file?path=${encodeURIComponent(relPath)}`,
  );
  return await jsonOrThrow<CodeFile>(res);
}

// ---- Queue / Questions ----

export async function getQueue(): Promise<QueueSnapshot> {
  const res = await authFetch(`${apiBaseUrl()}/queue`);
  return await jsonOrThrow<QueueSnapshot>(res);
}

export async function listEligible(): Promise<
  Array<{ task: Task; feature_name?: string }>
> {
  const res = await authFetch(`${apiBaseUrl()}/queue/eligible`);
  const body = await jsonOrThrow<{
    eligible: Array<{ task: Task; feature_name?: string }>;
  }>(res);
  return body.eligible;
}

export async function listQuestions(
  slug: string,
  status?: "open" | "answered" | "dismissed",
): Promise<Question[]> {
  const qs = status ? `?status=${encodeURIComponent(status)}` : "";
  const res = await authFetch(
    `${apiBaseUrl()}/projects/${encodeURIComponent(slug)}/questions${qs}`,
  );
  const body = await jsonOrThrow<{ questions: Question[] }>(res);
  return body.questions;
}

// ---- Tools / Cron (Phase 10 / 11) ----

export async function listTools(includeArchived = false): Promise<Tool[]> {
  const url = `${apiBaseUrl()}/tools${includeArchived ? "?include_archived=1" : ""}`;
  const res = await authFetch(url);
  const body = await jsonOrThrow<{ tools: Tool[] }>(res);
  return body.tools;
}

export async function getTool(id: string): Promise<Tool> {
  const res = await authFetch(`${apiBaseUrl()}/tools/${encodeURIComponent(id)}`);
  const body = await jsonOrThrow<{ tool: Tool }>(res);
  return body.tool;
}

export async function listCronJobs(): Promise<CronJob[]> {
  const res = await authFetch(`${apiBaseUrl()}/cron`);
  const body = await jsonOrThrow<{ jobs: CronJob[] }>(res);
  return body.jobs;
}

// ---- Rules (Phase 12) ----

export async function listGlobalRules(includeArchived = false): Promise<Rule[]> {
  const url = `${apiBaseUrl()}/rules${includeArchived ? "?include_archived=1" : ""}`;
  const res = await authFetch(url);
  const body = await jsonOrThrow<{ rules: Rule[] }>(res);
  return body.rules;
}

export async function listProjectRules(slug: string, includeArchived = false): Promise<Rule[]> {
  const url = `${apiBaseUrl()}/projects/${encodeURIComponent(slug)}/rules${
    includeArchived ? "?include_archived=1" : ""
  }`;
  const res = await authFetch(url);
  const body = await jsonOrThrow<{ rules: Rule[] }>(res);
  return body.rules;
}

// ---- Tool Proposals (Phase 13) ----

export async function listToolProposals(includeAll = false): Promise<ToolProposal[]> {
  const url = `${apiBaseUrl()}/tool_proposals${includeAll ? "?include_all=1" : ""}`;
  const res = await authFetch(url);
  const body = await jsonOrThrow<{ proposals: ToolProposal[] }>(res);
  return body.proposals;
}

// ---- Personas (Phase 14) ----

export async function listGlobalPersonas(includeArchived = false): Promise<Persona[]> {
  const url = `${apiBaseUrl()}/personas${includeArchived ? "?include_archived=1" : ""}`;
  const res = await authFetch(url);
  const body = await jsonOrThrow<{ personas: Persona[] }>(res);
  return body.personas;
}

export async function listProjectPersonas(slug: string, includeArchived = false): Promise<Persona[]> {
  const url = `${apiBaseUrl()}/projects/${encodeURIComponent(slug)}/personas${
    includeArchived ? "?include_archived=1" : ""
  }`;
  const res = await authFetch(url);
  const body = await jsonOrThrow<{ personas: Persona[] }>(res);
  return body.personas;
}

/**
 * Returns the resolved lens panel for the requested scope. Pass a
 * project slug for the project-scoped resolution; omit for the
 * "what would the council look like for a global preview" view.
 */
export async function listResolvedPersonas(slug?: string): Promise<ResolvedPersona[]> {
  const url = slug
    ? `${apiBaseUrl()}/projects/${encodeURIComponent(slug)}/personas/resolved`
    : `${apiBaseUrl()}/personas/resolved`;
  const res = await authFetch(url);
  const body = await jsonOrThrow<{ personas: ResolvedPersona[] }>(res);
  return body.personas;
}

// ---- Voice (Phase 15) ----
//
// All three endpoints proxy the upstream STT/TTS hosts (configured
// server-side via VOICE_STT_URL / VOICE_TTS_URL — typically a Jetson
// Orin or any compatible service). The client never has to know the
// upstream URLs. Voice is feature-flagged off when VOICE_*_URL aren't
// set — `getVoiceHealth` returns `{ available: false, ... }` and the
// UI hides the mic.

export interface VoiceHealth {
  available: boolean;
  /** Phase 19 — set when the user has explicitly toggled voice off. */
  disabled_by_user?: boolean;
  stt: { ok: boolean; reason?: string; model?: string; device?: string };
  tts: { ok: boolean; reason?: string; voice?: string; sample_rate?: number };
}

export async function getVoiceHealth(): Promise<VoiceHealth> {
  const res = await authFetch(`${apiBaseUrl()}/v1/voice/health`);
  return await jsonOrThrow<VoiceHealth>(res);
}

export interface TranscribeResponse {
  text: string;
  language: string;
  duration: number;
}

/**
 * Upload an audio Blob and get back the transcribed text. The
 * server proxies the multipart wrapping; we send the raw audio +
 * its content type via headers. `language` is optional — Whisper
 * auto-detects when omitted.
 */
export interface SpokenForTextResponse {
  spoken_text: string;
  source: "passthrough" | "summary" | "truncate" | "empty";
  original_chars: number;
}

/**
 * Phase 15.1 — fetch the TTS-friendly version of an assistant
 * reply. Server returns the original text unchanged when it's
 * short enough to speak in full; longer replies come back
 * summarized (or truncated as a deterministic fallback). The chat
 * UI is unaffected — this is purely the speaker's input source.
 *
 * Called once per voice-triggered turn, after the assistant
 * stream finishes. Adds a small extra latency before audio starts
 * (round-trip + summary call when used) but in exchange we don't
 * subject the user to listening to a full essay aloud.
 */
export async function getSpokenForText(text: string): Promise<SpokenForTextResponse> {
  const res = await authFetch(`${apiBaseUrl()}/v1/voice/spoken_for_text`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  return await jsonOrThrow<SpokenForTextResponse>(res);
}

/**
 * Phase 17 — Cursor usage panel. Mirror of the server's
 * `CursorUsageResult` envelope. The pill renders both shapes
 * (ok and unavailable) so we never blank out — degraded state
 * tells the user where to click instead.
 */
export type CursorUsageResult =
  | {
      status: "ok";
      plan: { name: string; price: string | null; includedCents: number };
      cycle: { startMs: number | null; endMs: number };
      spend: {
        totalCents: number;
        includedCents: number;
        bonusCents: number;
        remainingCents: number;
        percentUsed: number;
      };
      overage: {
        individualLimitCents: number | null;
        individualUsedCents: number | null;
      };
      displayMessage: string | null;
      fetchedAt: number;
    }
  | {
      status: "unavailable";
      reason: string;
      dashboardUrl: string;
      fetchedAt: number;
    };

export async function getCursorUsage(force = false): Promise<CursorUsageResult> {
  const url = `${apiBaseUrl()}/v1/cursor/usage${force ? "?force=1" : ""}`;
  const res = await authFetch(url);
  return await jsonOrThrow<CursorUsageResult>(res);
}

/**
 * Phase 20 — fetch the per-role model selection. Read-only;
 * updates funnel through `applyMutation({ kind: "set_models", … })`
 * which fires a `model_settings_changed` WS event so all open
 * tabs refresh their dropdowns.
 */
export async function getModelSettings(): Promise<{ chat: string; agent: string }> {
  const res = await authFetch(`${apiBaseUrl()}/v1/settings/models`);
  return await jsonOrThrow<{ chat: string; agent: string }>(res);
}

/**
 * Phase 21 — voice endpoint config (URLs, auth status, voice
 * catalog name, language). Auth tokens are never returned in
 * cleartext — the server replaces a configured token with `"***"`
 * so the UI can show "configured" without leaking the secret.
 *
 * The `effective_*` fields fold env-var fallback into one resolved
 * value the UI can render as the live setting; `source` tells you
 * whether the live value came from the settings file or `.env`.
 */
export interface VoiceEndpointSettings {
  disabled: boolean;
  stt: {
    url: string;
    auth: string;
    effective_url: string;
    source: "settings" | "env" | "unset";
  };
  tts: {
    url: string;
    auth: string;
    voice: string;
    language: string;
    effective_url: string;
    effective_voice: string;
    effective_language: string;
    source: "settings" | "env" | "unset";
  };
}

export async function getVoiceSettings(): Promise<VoiceEndpointSettings> {
  const res = await authFetch(`${apiBaseUrl()}/v1/settings/voice`);
  return await jsonOrThrow<VoiceEndpointSettings>(res);
}

/**
 * Patch voice endpoint config (URLs, auth, voice, language) in
 * one shot. Each field is independent: omit to leave alone, send
 * `""` to clear (env-var fallback wins), send the literal `"***"`
 * to leave an existing auth token untouched (so the form can be
 * resubmitted without re-pasting secrets).
 *
 * Goes through PATCH (not the mutation envelope) because auth
 * tokens shouldn't ride the chat pipeline.
 */
export async function setVoiceSettings(patch: {
  stt_url?: string;
  stt_auth?: string;
  tts_url?: string;
  tts_auth?: string;
  voice?: string;
  language?: string;
}): Promise<VoiceEndpointSettings> {
  const res = await authFetch(`${apiBaseUrl()}/v1/settings/voice`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  return await jsonOrThrow<VoiceEndpointSettings>(res);
}

export async function transcribeAudio(
  blob: Blob,
  opts: { language?: string; filename?: string } = {},
): Promise<TranscribeResponse> {
  const params = new URLSearchParams();
  if (opts.language) params.set("language", opts.language);
  const qs = params.toString();
  const url = `${apiBaseUrl()}/v1/voice/transcribe${qs ? `?${qs}` : ""}`;
  const res = await authFetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Audio-Content-Type": blob.type || "audio/webm",
      ...(opts.filename ? { "X-Audio-Filename": opts.filename } : {}),
    },
    body: blob,
  });
  return await jsonOrThrow<TranscribeResponse>(res);
}

// ---- Mutations envelope ----

export interface MutationResponse {
  ok: boolean;
  kind?: string;
  result?: unknown;
  error?: string;
}

export async function applyMutation(envelope: unknown): Promise<MutationResponse> {
  const res = await authFetch(`${apiBaseUrl()}/v1/mutations/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(envelope),
  });
  return (await res.json()) as MutationResponse;
}
