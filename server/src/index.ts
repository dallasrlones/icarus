import express, { type Request, type Response } from "express";
import cors from "cors";
import { ChatStore } from "./chats.js";
import * as cursor from "./cursor.js";
import { events } from "./events.js";
import { applyMutation } from "./mutations/apply.js";
import { dataRoot } from "./storage/paths.js";
import { ensureDir } from "./storage/json.js";
import { readFleet } from "./storage/fleet.js";
import { tailGlobalActivity, tailProjectActivity } from "./storage/activity.js";
import { readFeatures, readFlows, readTasks } from "./storage/entities.js";
import { initCouncilRunner } from "./council/runner.js";
import { listRuns, loadRun } from "./council/storage.js";
import type { CouncilRunType } from "./council/types.js";
import { initQueueWorker, getQueueWorker } from "./queue/worker.js";
import { readQuestions } from "./queue/storage.js";
import { listTaskRuns } from "./queue/storage.js";
import {
  CodeBrowserError,
  listDir,
  listDirAt,
  readFile as readWorkspaceFile,
  readFileAt,
} from "./code/files.js";
import { cronWorkspaceDir } from "./storage/paths.js";
import {
  readRuns as readCronRuns,
  readTranscript as readCronTranscript,
} from "./storage/cron_runs.js";
import { initCronScheduler } from "./cron/scheduler.js";
import { findToolByRef, readTools } from "./storage/tools.js";
import { readCronJobs } from "./storage/cron.js";
import { readGlobalRules, readProjectRules } from "./storage/rules.js";
import { readToolProposals } from "./storage/tool_proposals.js";
import { readGlobalPersonas, readProjectPersonas } from "./storage/personas.js";
import { resolveCouncilPersonas } from "./personas/registry.js";
import { isVoiceEnabled, readVoiceConfig } from "./voice/config.js";
import { readVoiceHealth } from "./voice/health.js";
import { transcribe, VoiceProxyError } from "./voice/stt.js";
import { synthesize, splitSentencesForTTS } from "./voice/tts.js";
import { computeSpokenForText } from "./voice/spoken.js";
import { getCursorUsage } from "./cursor_usage/client.js";
import { patchVoiceEndpoints, readSettings } from "./storage/settings.js";
import { awaitTaskFinish } from "./events.js";
import { authRouter } from "./auth/routes.js";
import { requireAuth, requireMutablePassword } from "./auth/middleware.js";
import { ensureBootstrapAdmin } from "./auth/service.js";
import { closeAuthDb } from "./auth/db.js";
import { ensureBootstrapRules } from "./rules/bootstrap.js";
import {
  buildToolRunView,
  findTaskAcrossProjects,
  listToolRunsForTool,
  toolView,
} from "./api/tool_runs.js";
import type { ChatScope } from "./storage/chats.js";

const PORT = Number(process.env.PORT ?? 4000);
const CURSOR_BIN = process.env.CURSOR_BIN ?? "cursor-agent";
const CURSOR_MODEL = process.env.CURSOR_MODEL || undefined;
const CURSOR_CWD = process.env.CURSOR_CWD ?? process.cwd();
const ALLOW_FILE_WRITES = (process.env.CURSOR_ALLOW_FILE_WRITES ?? "").toLowerCase() === "true";
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT ?? CURSOR_CWD;

const cursorOpts = {
  binary: CURSOR_BIN,
  cwd: CURSOR_CWD,
  model: CURSOR_MODEL,
  allowFileWrites: ALLOW_FILE_WRITES,
};

const applyCtx = { workspaceRoot: WORKSPACE_ROOT };
const store = new ChatStore(cursorOpts, applyCtx);
initCouncilRunner({ cursor: cursorOpts });
initQueueWorker({ cursor: cursorOpts, applyCtx });
initCronScheduler({ applyCtx, cursorOpts });

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// ---- Auth ---------------------------------------------------------------
//
// `requireAuth` runs for every request but internally whitelists the
// public paths (`/health`, `/v1/auth/login`). For everything else it
// validates the JWT and populates `req.auth` so downstream handlers
// — including `/v1/auth/me`, `/v1/auth/change-password`,
// `/v1/auth/logout` — can read the current user.
//
// `requireMutablePassword` is layered on top: while a user has
// `must_change_password=true` (default admin on first sign-in), every
// route except `/v1/auth/{me,logout,change-password}` returns 403
// with `must_change_password: true` so the client routes to the
// forced password-change screen.
app.use(requireAuth);
app.use(requireMutablePassword);
app.use("/v1/auth", authRouter);

app.get("/health", async (_req, res) => {
  try {
    const probe = await cursor.probe(cursorOpts);
    res.json({
      ok: true,
      ...probe,
      model: CURSOR_MODEL ?? "(default)",
      cwd: CURSOR_CWD,
      data_root: dataRoot(),
    });
  } catch (err) {
    res.status(503).json({
      ok: false,
      error: err instanceof Error ? err.message : "cursor-agent unavailable",
    });
  }
});

// ---- Project endpoints ----

app.get("/projects", async (req, res) => {
  const fleet = await readFleet();
  const includeArchived = req.query.include_archived === "true" || req.query.include_archived === "1";
  const projects = includeArchived
    ? fleet.projects
    : fleet.projects.filter((p) => p.status !== "archived");
  res.json({ projects });
});

app.get("/projects/:slug", async (req, res) => {
  const slug = String(req.params.slug);
  const fleet = await readFleet();
  const project = fleet.projects.find((p) => p.slug === slug);
  if (!project) return res.status(404).json({ error: "not found" });

  const [features, tasks, flows] = await Promise.all([
    readFeatures(slug),
    readTasks(slug),
    readFlows(slug),
  ]);
  const activeFeatures = features.filter((f) => f.status !== "archived").length;

  res.json({
    project,
    counts: {
      features: activeFeatures,
      tasks: tasks.length,
      flows: flows.length,
    },
  });
});

app.get("/projects/:slug/features", async (req, res) => {
  const slug = String(req.params.slug);
  const includeArchived = req.query.include_archived === "true" || req.query.include_archived === "1";
  const all = await readFeatures(slug);
  const features = includeArchived ? all : all.filter((f) => f.status !== "archived");
  res.json({ features });
});

app.get("/projects/:slug/flows", async (req, res) => {
  const slug = String(req.params.slug);
  const flows = await readFlows(slug);
  res.json({ flows });
});

app.get("/projects/:slug/flows/:feature_id", async (req, res) => {
  const slug = String(req.params.slug);
  const featureId = String(req.params.feature_id);
  const flows = await readFlows(slug);
  const flow = flows.find((f) => f.feature_id === featureId);
  res.json({
    flow: flow ?? { feature_id: featureId, nodes: [], edges: [], updated_at: 0 },
  });
});

app.get("/projects/:slug/tasks", async (req, res) => {
  const slug = String(req.params.slug);
  const tasks = await readTasks(slug);
  res.json({ tasks });
});

app.get("/projects/:slug/activity", async (req, res) => {
  const slug = String(req.params.slug);
  const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 50)));
  const entries = await tailProjectActivity(slug, limit);
  res.json({ entries });
});

app.get("/projects/:slug/council/:feature_id", async (req, res) => {
  const slug = String(req.params.slug);
  const featureId = String(req.params.feature_id);
  const filterType = req.query.type ? String(req.query.type) : undefined;
  const filter = filterType
    ? { type: filterType as CouncilRunType }
    : undefined;
  const runs = await listRuns(slug, featureId, filter);
  res.json({ runs });
});

app.get("/projects/:slug/questions", async (req, res) => {
  const slug = String(req.params.slug);
  const status = req.query.status ? String(req.query.status) : undefined;
  const questions = await readQuestions(slug);
  res.json({
    questions: status ? questions.filter((q) => q.status === status) : questions,
  });
});

app.get("/projects/:slug/tasks/:task_id/runs", async (req, res) => {
  const slug = String(req.params.slug);
  const taskId = String(req.params.task_id);
  const runs = await listTaskRuns(slug, taskId);
  res.json({ runs });
});

app.get("/queue", (_req, res) => {
  const snap = getQueueWorker().snapshot();
  res.json(snap);
});

app.get("/projects/:slug/architecture", async (req, res) => {
  const slug = String(req.params.slug);
  const { readArchitecture } = await import("./storage/entities.js");
  const arch = await readArchitecture(slug);
  res.json({ architecture: arch });
});

app.get("/projects/:slug/files", async (req, res) => {
  const slug = String(req.params.slug);
  const rel = String(req.query.path ?? "");
  try {
    const out = await listDir(slug, rel);
    res.json(out);
  } catch (err) {
    if (err instanceof CodeBrowserError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/projects/:slug/file", async (req, res) => {
  const slug = String(req.params.slug);
  const rel = String(req.query.path ?? "");
  if (!rel) {
    res.status(400).json({ error: "path query param is required" });
    return;
  }
  try {
    const out = await readWorkspaceFile(slug, rel);
    res.json(out);
  } catch (err) {
    if (err instanceof CodeBrowserError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/tools", async (req, res) => {
  const includeArchived =
    req.query.include_archived === "true" || req.query.include_archived === "1";
  const tools = await readTools();
  res.json({
    tools: includeArchived ? tools : tools.filter((t) => t.status === "active"),
  });
});

// Slug-or-id resolver for the per-tool GET. Slug wins when both happen
// to match (e.g. someone names a tool literally "tool_xxx") because the
// id-namespace is opaque and slug-namespace is intentional.
app.get("/tools/:ref", async (req, res) => {
  const ref = String(req.params.ref);
  const tool = await findToolByRef(ref);
  if (!tool) return res.status(404).json({ error: "not found" });
  res.json({ tool });
});

// ---- Tools-as-API (Phase 10.1) ----
//
// Each active tool is callable at `POST /v1/tools/:ref/run` where `ref`
// is the slug (preferred) or id. Default mode returns a `run_id`
// immediately and the caller polls `GET /v1/tool_runs/:run_id`. With
// `wait=true` (query or body) the request blocks until the underlying
// task finishes (or `timeout_ms` elapses) and returns the structured
// result inline. Internal-only — no auth.

const DEFAULT_RUN_TIMEOUT_MS = 5 * 60_000;
const MAX_RUN_TIMEOUT_MS = 30 * 60_000;
const MIN_RUN_TIMEOUT_MS = 1_000;

function wantsWait(req: Request): boolean {
  const q = req.query.wait;
  if (q === "true" || q === "1") return true;
  const b = (req.body ?? {}).wait;
  return b === true || b === "true";
}

app.post("/v1/tools/:ref/run", async (req: Request, res: Response) => {
  const ref = String(req.params.ref);
  const tool = await findToolByRef(ref);
  if (!tool) return res.status(404).json({ error: `unknown tool: ${ref}` });
  if (tool.status !== "active") {
    return res.status(409).json({ error: `tool is archived: ${ref}` });
  }

  const body = req.body ?? {};
  const projectSlug = typeof body.project_slug === "string" ? body.project_slug : "";
  if (!projectSlug) {
    return res.status(400).json({ error: "project_slug is required" });
  }

  // Forward through the existing mutation pipeline so coercion,
  // validation, project assertions, and queue dispatch all run exactly
  // as they would for an `applyMutation({kind: "run_tool"})` call from
  // the agent. This keeps a single code path.
  const applied = await applyMutation(
    {
      kind: "run_tool",
      payload: {
        tool_id: tool.id,
        project_slug: projectSlug,
        args: body.args && typeof body.args === "object" ? body.args : undefined,
        title: typeof body.title === "string" ? body.title : undefined,
        priority: typeof body.priority === "number" ? body.priority : undefined,
        auto_start: true,
      },
    },
    applyCtx,
  );
  if (!applied.ok) {
    return res.status(applied.status).json({ ok: false, error: applied.error });
  }
  // `apply` for a successful `run_tool` envelope returns the freshly
  // created Task. Loosely typed across the mutation surface, so we
  // pull it out via a narrow cast and re-fetch through
  // `findTaskAcrossProjects` for the response — that path is shared
  // with polling and stays the source of truth.
  const startResult = applied.result as { task: import("./domain.js").Task };
  const taskId = startResult.task.id;

  if (wantsWait(req)) {
    const requested = Number(body.timeout_ms ?? req.query.timeout_ms ?? DEFAULT_RUN_TIMEOUT_MS);
    const timeout = Math.min(
      MAX_RUN_TIMEOUT_MS,
      Math.max(MIN_RUN_TIMEOUT_MS, Number.isFinite(requested) ? requested : DEFAULT_RUN_TIMEOUT_MS),
    );
    // The worker broadcasts `task_finished` *after* persisting the run
    // record (see queue/worker.ts), so the read below is safe.
    const event = await awaitTaskFinish(taskId, timeout);
    const found = await findTaskAcrossProjects(taskId);
    if (!found) {
      return res.status(500).json({ error: "task disappeared after dispatch" });
    }
    const view = await buildToolRunView(found.task, found.project_slug, tool);
    if (!event) {
      return res.status(202).json({
        ok: true,
        run: view,
        note: `timed out waiting after ${timeout}ms; run may still be in progress`,
      });
    }
    return res.json({ ok: true, run: view });
  }

  const view = await buildToolRunView(startResult.task, projectSlug, tool);
  res.status(202).json({ ok: true, run: view });
});

app.get("/v1/tool_runs/:run_id", async (req, res) => {
  const runId = String(req.params.run_id);
  const found = await findTaskAcrossProjects(runId);
  if (!found) return res.status(404).json({ error: "not found" });
  const tool = found.task.tool_id ? await findToolByRef(found.task.tool_id) : null;
  const view = await buildToolRunView(found.task, found.project_slug, tool);
  res.json({ run: view });
});

app.get("/v1/tools/:ref/runs", async (req, res) => {
  const ref = String(req.params.ref);
  const tool = await findToolByRef(ref);
  if (!tool) return res.status(404).json({ error: `unknown tool: ${ref}` });
  const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 20)));
  const projectSlug = req.query.project_slug ? String(req.query.project_slug) : undefined;
  const matches = await listToolRunsForTool(tool.id, projectSlug);
  const slice = matches.slice(0, limit);
  const runs = await Promise.all(
    slice.map(({ task, project_slug }) => buildToolRunView(task, project_slug, tool)),
  );
  res.json({ tool: toolView(tool), runs });
});

app.get("/cron", async (_req, res) => {
  const jobs = await readCronJobs();
  res.json({ jobs });
});

// ---- Standalone cron — run history + workspace file browser (Phase 23) ----
//
// Read-only views over the data the standalone runner persists:
//   `store/_cron/<slug>/runs.jsonl`           (one CronRun per tick)
//   `store/_cron/<slug>/transcripts/<run>.jsonl` (cursor-agent stream)
//   `<WORKSPACE_ROOT>/_cron/<slug>/`          (cron-owned workspace)
//
// Project counterparts: `/projects/:slug/files` and `/projects/:slug/file`.
// We resolve the cron job by id (durable handle) and use its slug to
// locate disk paths.

app.get("/v1/cron/:cron_id/runs", async (req, res) => {
  const cronId = String(req.params.cron_id);
  const jobs = await readCronJobs();
  const job = jobs.find((j) => j.id === cronId);
  if (!job) return res.status(404).json({ error: "unknown cron job" });
  if (!job.slug || job.target.kind !== "standalone") {
    return res.json({ runs: [] });
  }
  const runs = await readCronRuns(job.slug);
  // Newest-first for the UI.
  runs.sort((a, b) => b.started_at - a.started_at);
  res.json({ runs });
});

app.get("/v1/cron/:cron_id/runs/:run_id/transcript", async (req, res) => {
  const cronId = String(req.params.cron_id);
  const runId = String(req.params.run_id);
  const jobs = await readCronJobs();
  const job = jobs.find((j) => j.id === cronId);
  if (!job) return res.status(404).json({ error: "unknown cron job" });
  if (!job.slug || job.target.kind !== "standalone") {
    return res.status(400).json({ error: "cron job has no transcripts (not a standalone target)" });
  }
  const text = await readCronTranscript(job.slug, runId);
  res.json({ run_id: runId, text });
});

app.get("/v1/cron/:cron_id/files", async (req, res) => {
  const cronId = String(req.params.cron_id);
  const rel = String(req.query.path ?? "");
  const jobs = await readCronJobs();
  const job = jobs.find((j) => j.id === cronId);
  if (!job) return res.status(404).json({ error: "unknown cron job" });
  if (!job.slug || job.target.kind !== "standalone") {
    return res.status(400).json({
      error: "cron job has no workspace (not a standalone target)",
    });
  }
  try {
    const out = await listDirAt(cronWorkspaceDir(WORKSPACE_ROOT, job.slug), rel);
    res.json(out);
  } catch (err) {
    if (err instanceof CodeBrowserError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/v1/cron/:cron_id/file", async (req, res) => {
  const cronId = String(req.params.cron_id);
  const rel = String(req.query.path ?? "");
  if (!rel) return res.status(400).json({ error: "path query param is required" });
  const jobs = await readCronJobs();
  const job = jobs.find((j) => j.id === cronId);
  if (!job) return res.status(404).json({ error: "unknown cron job" });
  if (!job.slug || job.target.kind !== "standalone") {
    return res.status(400).json({
      error: "cron job has no workspace (not a standalone target)",
    });
  }
  try {
    const out = await readFileAt(cronWorkspaceDir(WORKSPACE_ROOT, job.slug), rel);
    res.json(out);
  } catch (err) {
    if (err instanceof CodeBrowserError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ---- Tool Proposals (Phase 13) ----
//
// Default returns only `pending` proposals — that's what the
// suggestions banner renders. Pass `?include_all=1` for the full
// history (accepted + rejected too) when the user wants to review
// past decisions.

app.get("/tool_proposals", async (req, res) => {
  const includeAll =
    req.query.include_all === "true" || req.query.include_all === "1";
  const all = await readToolProposals();
  res.json({
    proposals: includeAll ? all : all.filter((p) => p.status === "pending"),
  });
});

// ---- Council personas (Phase 14) ----
//
// Two surfaces:
//   - The raw persona registries (`/personas`, `/projects/:slug/personas`)
//     for the editor UI to list / edit / archive entries the user owns.
//   - The *resolved* lens set (`/personas/resolved`,
//     `/projects/:slug/personas/resolved`) for the council preview UI
//     to show "what will actually run" with provenance per slot
//     (default | global override | project override | new addition).
//
// Archived personas are filtered out of `/personas/*` by default; pass
// `?include_archived=1` to fetch them too (used by the editor's
// "Show archived" toggle).

app.get("/personas", async (req, res) => {
  const includeArchived =
    req.query.include_archived === "true" || req.query.include_archived === "1";
  const all = await readGlobalPersonas();
  res.json({
    personas: includeArchived ? all : all.filter((p) => p.status === "active"),
  });
});

app.get("/projects/:slug/personas", async (req, res) => {
  const slug = String(req.params.slug);
  const includeArchived =
    req.query.include_archived === "true" || req.query.include_archived === "1";
  const all = await readProjectPersonas(slug);
  res.json({
    personas: includeArchived ? all : all.filter((p) => p.status === "active"),
  });
});

app.get("/personas/resolved", async (_req, res) => {
  const personas = await resolveCouncilPersonas();
  res.json({ personas });
});

app.get("/projects/:slug/personas/resolved", async (req, res) => {
  const slug = String(req.params.slug);
  const personas = await resolveCouncilPersonas(slug);
  res.json({ personas });
});

// ---- Voice proxy (Phase 15) ----
//
// Three endpoints, all under /v1/voice. icarus-server is the only
// thing that knows the upstream STT/TTS URLs — clients never
// hardcode them. Health is cheap (small JSON), transcribe is bounded
// (~10 MB per upload), synthesize is JSON-in / WAV-out and can run
// long for big inputs (XTTS chunks faster than realtime, but a
// 5000-char input still takes a few seconds).
//
// `/v1/voice/transcribe` uses raw body parsing instead of multer:
// the client uploads `application/octet-stream` with the original
// audio's content-type passed via `X-Audio-Content-Type` (so a
// browser webm and an Expo m4a hit the same code path). The proxy
// rewraps as multipart for the Orin's FastAPI. This avoids adding
// multer/formidable just for one endpoint.

app.get("/v1/voice/health", async (_req, res) => {
  const cfg = await readVoiceConfig();
  const health = await readVoiceHealth(cfg);
  res.json(health);
});

/**
 * Phase 19 — voice user toggle.
 *
 * `disabled: true` short-circuits the upstream probe in
 * `readVoiceHealth` and makes every voice POST endpoint
 * fast-fail with 503. Use it when you're off the local network
 * and don't want to eat the 4-second probe timeout per poll.
 *
 * The toggle is a hard server-side switch — clients see
 * `disabled_by_user: true` on the next health poll and hide
 * the mic button instantly. Flipping back on triggers the
 * normal probe; if the upstream is reachable the mic returns
 * within one poll.
 *
 * The `set_voice_enabled` mutation hits the same path so the
 * agent can flip it from chat too ("turn off voice", "I'm
 * home, voice on").
 */
app.get("/v1/settings/voice", async (_req, res) => {
  const settings = await readSettings();
  const cfg = await readVoiceConfig();
  // Auth tokens are write-only over the wire — render as "***"
  // when present so the UI can show "configured" without leaking
  // the secret to anyone who can read the settings JSON over HTTP.
  res.json({
    disabled: settings.voice.disabled,
    stt: {
      url: settings.voice.stt.url,
      auth: settings.voice.stt.auth ? "***" : "",
      effective_url: cfg.sttUrl ?? "",
      source: cfg.source.stt,
    },
    tts: {
      url: settings.voice.tts.url,
      auth: settings.voice.tts.auth ? "***" : "",
      voice: settings.voice.tts.voice,
      language: settings.voice.tts.language,
      effective_url: cfg.ttsUrl ?? "",
      effective_voice: cfg.ttsVoice,
      effective_language: cfg.ttsLanguage,
      source: cfg.source.tts,
    },
  });
});

/**
 * Phase 21 — direct PATCH for voice endpoint config.
 *
 * Why direct (not through the mutation envelope) — auth tokens
 * shouldn't ride the chat pipeline. The mutation envelope is
 * inspectable in chat history and the activity log, and a careless
 * agent could echo a Bearer token back to the user. PATCH stays
 * UI-only.
 *
 * Each field is independent:
 *   - field omitted → leave current value untouched
 *   - field === ""  → clear (env-var fallback wins)
 *   - field === "***" (echoed back from GET) → leave untouched.
 *     Lets the UI submit the form without forcing the user to
 *     re-paste an unchanged auth token.
 */
app.patch("/v1/settings/voice", express.json(), async (req, res) => {
  const body = (req.body ?? {}) as {
    stt_url?: unknown;
    stt_auth?: unknown;
    tts_url?: unknown;
    tts_auth?: unknown;
    voice?: unknown;
    language?: unknown;
  };

  function pickStr(v: unknown): string | undefined {
    if (v === undefined) return undefined;
    if (typeof v !== "string") return undefined;
    if (v === "***") return undefined;
    return v;
  }

  const next = await patchVoiceEndpoints({
    stt_url: pickStr(body.stt_url),
    stt_auth: pickStr(body.stt_auth),
    tts_url: pickStr(body.tts_url),
    tts_auth: pickStr(body.tts_auth),
    voice: pickStr(body.voice),
    language: pickStr(body.language),
  });

  // Broadcast so any open Settings tab refreshes its form + the
  // sidebar voice pill re-probes for health on the new endpoint.
  events.broadcast({
    type: "voice_settings_changed",
    disabled: next.voice.disabled,
    ts: Date.now(),
  });

  const cfg = await readVoiceConfig();
  res.json({
    ok: true,
    stt: {
      url: next.voice.stt.url,
      auth: next.voice.stt.auth ? "***" : "",
      effective_url: cfg.sttUrl ?? "",
      source: cfg.source.stt,
    },
    tts: {
      url: next.voice.tts.url,
      auth: next.voice.tts.auth ? "***" : "",
      voice: next.voice.tts.voice,
      language: next.voice.tts.language,
      effective_url: cfg.ttsUrl ?? "",
      effective_voice: cfg.ttsVoice,
      effective_language: cfg.ttsLanguage,
      source: cfg.source.tts,
    },
  });
});

/**
 * Phase 20 — per-role model selection. `chat` is used by the chat
 * handler + voice spoken-summary; `agent` is used by the queue
 * worker, council runs, and tool runs. Flipped via the
 * `set_models` mutation (same applicator path the agent uses).
 * Read-only here — no PUT, since updates funnel through the
 * mutation envelope so clients also get a `model_settings_changed`
 * broadcast for free.
 */
app.get("/v1/settings/models", async (_req, res) => {
  const settings = await readSettings();
  res.json(settings.models);
});

/**
 * Helper: 503 fast-fail when the user has flipped voice off.
 * Returns true when the request was short-circuited so the
 * caller can early-return without further processing.
 */
async function voiceUserDisabledGuard(res: Response): Promise<boolean> {
  const settings = await readSettings();
  if (settings.voice.disabled) {
    res.status(503).json({
      error: "voice disabled by user",
      disabled_by_user: true,
    });
    return true;
  }
  return false;
}

// Phase 17 — Cursor usage panel. Returns current billing-cycle
// spend / limit / percent from Cursor's undocumented dashboard
// service. ?force=1 bypasses the 5-minute cache for an explicit
// "refresh now" click in the UI. Unavailable upstream is a clean
// `{status:"unavailable", reason}` envelope, never a 5xx, so the
// pill can stay rendered with a friendly fallback.
app.get("/v1/cursor/usage", async (req, res) => {
  const force = req.query.force === "1" || req.query.force === "true";
  const usage = await getCursorUsage(force);
  res.json(usage);
});

app.post(
  "/v1/voice/transcribe",
  // 25 MB cap — well above any reasonable PTT clip (raw 16-bit
  // 16kHz mono is 32 KB/s; webm/m4a are smaller).
  express.raw({ type: "*/*", limit: "25mb" }),
  async (req, res) => {
    if (await voiceUserDisabledGuard(res)) return;
    const cfg = await readVoiceConfig();
    if (!isVoiceEnabled(cfg)) {
      res.status(503).json({ error: "voice disabled (VOICE_*_URL not set)" });
      return;
    }
    const body = req.body as Buffer | undefined;
    if (!body || body.length === 0) {
      res.status(400).json({ error: "empty body" });
      return;
    }
    // Prefer the client-supplied original content-type so the Orin's
    // ffmpeg shim picks the right decoder. Fall back to the request's
    // Content-Type header (the raw parser sets it), then to webm.
    const contentType =
      String(req.header("x-audio-content-type") || req.header("content-type") || "audio/webm");
    const filename = req.header("x-audio-filename") || undefined;
    const language = typeof req.query.language === "string" ? req.query.language : undefined;
    const taskQ = typeof req.query.task === "string" ? req.query.task : undefined;
    const task =
      taskQ === "transcribe" || taskQ === "translate" ? taskQ : undefined;
    try {
      const result = await transcribe(cfg, new Uint8Array(body), {
        contentType,
        filename,
        language,
        task,
      });
      res.json({
        text: result.text,
        language: result.language,
        duration: result.duration,
        // Don't echo the full segment array — clients only need the
        // transcript and language; debugging can pull `?verbose=1`.
        ...(req.query.verbose ? { segments: result.segments, language_probability: result.language_probability } : {}),
      });
    } catch (err) {
      handleVoiceError(res, err);
    }
  },
);

app.post("/v1/voice/synthesize", async (req, res) => {
  if (await voiceUserDisabledGuard(res)) return;
  const cfg = await readVoiceConfig();
  if (!isVoiceEnabled(cfg)) {
    res.status(503).json({ error: "voice disabled (VOICE_*_URL not set)" });
    return;
  }
  const { text, voice, language, speed } = (req.body ?? {}) as {
    text?: unknown;
    voice?: unknown;
    language?: unknown;
    speed?: unknown;
  };
  if (typeof text !== "string" || !text.trim()) {
    res.status(400).json({ error: "text is required" });
    return;
  }
  try {
    const out = await synthesize(cfg, {
      text,
      voice: typeof voice === "string" ? voice : undefined,
      language: typeof language === "string" ? language : undefined,
      speed: typeof speed === "number" ? speed : undefined,
    });
    res.setHeader("Content-Type", out.contentType);
    if (out.voice) res.setHeader("X-Voice", out.voice);
    if (out.language) res.setHeader("X-Language", out.language);
    res.send(Buffer.from(out.audio));
  } catch (err) {
    handleVoiceError(res, err);
  }
});

/**
 * Helper: split an assistant-side string into utterance-sized
 * sentence chunks. Exposed as an endpoint so the client can
 * incrementally synthesize a streamed reply without re-implementing
 * the splitter (and its markdown stripping). Pure function — no
 * upstream call, no rate limits.
 */
app.post("/v1/voice/split_sentences", (req, res) => {
  const { text, max_chars } = (req.body ?? {}) as { text?: unknown; max_chars?: unknown };
  if (typeof text !== "string") {
    res.status(400).json({ error: "text must be a string" });
    return;
  }
  const max = typeof max_chars === "number" && max_chars > 40 ? max_chars : 240;
  res.json({ chunks: splitSentencesForTTS(text, max) });
});

/**
 * Phase 15.1 — compute the *spoken* version of an assistant reply.
 *
 * Short replies (≤ ~600 chars after markdown stripping) come back
 * unchanged with `source: "passthrough"`. Longer replies trigger a
 * one-shot `cursor-agent` summary call (`source: "summary"`); on
 * failure we degrade to a deterministic truncate (`source:
 * "truncate"`) so audio always plays.
 *
 * The chat display is unaffected — this endpoint exists purely so
 * the client can fetch a TTS-friendly version of the full reply
 * once a turn completes, without hand-rolling the same logic on
 * every client.
 */
app.post("/v1/voice/spoken_for_text", async (req, res) => {
  if (await voiceUserDisabledGuard(res)) return;
  const { text } = (req.body ?? {}) as { text?: unknown };
  if (typeof text !== "string" || !text.trim()) {
    res.status(400).json({ error: "text must be a non-empty string" });
    return;
  }
  try {
    const result = await computeSpokenForText(text, cursorOpts);
    res.json(result);
  } catch (err) {
    // computeSpokenForText is designed to never throw, but belt-and-
    // suspenders: surface a usable error instead of dropping the
    // turn into "no audio, no signal" purgatory.
    handleVoiceError(res, err);
  }
});

function handleVoiceError(res: Response, err: unknown): void {
  if (err instanceof VoiceProxyError) {
    res.status(err.httpStatus).json({
      error: err.message,
      ...(err.upstreamBody ? { upstream: err.upstreamBody.slice(0, 500) } : {}),
    });
    return;
  }
  const msg = err instanceof Error ? err.message : String(err);
  res.status(500).json({ error: msg });
}

// ---- Rules (Phase 12) ----
//
// Two scopes, two endpoints. The UI fetches both — the global tab uses
// /rules and the per-project tab uses /projects/:slug/rules. Archived
// rules are filtered by default; pass `?include_archived=1` to fetch
// the full set (used by the editor's "Show archived" toggle).

app.get("/rules", async (req, res) => {
  const includeArchived =
    req.query.include_archived === "true" || req.query.include_archived === "1";
  const all = await readGlobalRules();
  res.json({
    rules: includeArchived ? all : all.filter((r) => r.status === "active"),
  });
});

app.get("/projects/:slug/rules", async (req, res) => {
  const slug = String(req.params.slug);
  const includeArchived =
    req.query.include_archived === "true" || req.query.include_archived === "1";
  const all = await readProjectRules(slug);
  res.json({
    rules: includeArchived ? all : all.filter((r) => r.status === "active"),
  });
});

app.get("/queue/eligible", async (_req, res) => {
  try {
    const list = await getQueueWorker().listEligible();
    res.json({
      eligible: list.map(({ task, feature }) => ({
        task,
        feature_name: feature?.name,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/projects/:slug/council/:feature_id/:run_type/:run_id", async (req, res) => {
  const slug = String(req.params.slug);
  const featureId = String(req.params.feature_id);
  const runType = String(req.params.run_type) as CouncilRunType;
  if (runType !== "flow_review" && runType !== "task_planning") {
    return res.status(400).json({ error: "invalid run_type" });
  }
  const runId = String(req.params.run_id);
  const run = await loadRun(slug, featureId, runType, runId);
  if (!run) return res.status(404).json({ error: "not found" });
  res.json({ run });
});

app.get("/activity", async (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 50)));
  const entries = await tailGlobalActivity(limit);
  res.json({ entries });
});

// ---- Chat endpoints (scope-aware via path) ----
//
// /chats/...                    → global scope (back-compat)
// /projects/:slug/chats/...     → project scope

function bindChatRoutes(prefix: string, scopeFor: (req: Request) => ChatScope) {
  app.get(`${prefix}`, async (req, res) => {
    res.json({ chats: await store.list(scopeFor(req)) });
  });

  app.post(`${prefix}`, async (req, res) => {
    try {
      const chat = await store.create(scopeFor(req));
      res.status(201).json({ chat });
    } catch (err) {
      const message = err instanceof Error ? err.message : "failed to create chat";
      res.status(500).json({ error: message });
    }
  });

  app.get(`${prefix}/:id`, async (req, res) => {
    const id = String(req.params.id);
    const chat = await store.get(scopeFor(req), id);
    if (!chat) return res.status(404).json({ error: "not found" });
    res.json({ chat });
  });

  app.delete(`${prefix}/:id`, async (req, res) => {
    const id = String(req.params.id);
    if (!(await store.remove(scopeFor(req), id))) return res.status(404).json({ error: "not found" });
    res.status(204).end();
  });

  app.post(`${prefix}/:id/messages`, async (req: Request, res: Response) => {
    const scope = scopeFor(req);
    const id = String(req.params.id);
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    // Phase 15: optional opaque per-tab id so agent-emitted
    // `navigate` mutations can target the originating client.
    const clientId =
      typeof req.body?.client_id === "string" && req.body.client_id.length > 0
        ? req.body.client_id
        : undefined;
    if (!text) return res.status(400).json({ error: "text is required" });
    if (!(await store.get(scope, id))) return res.status(404).json({ error: "not found" });

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    const ac = new AbortController();
    const onClientGone = () => ac.abort();
    res.once("close", () => {
      if (!res.writableEnded) onClientGone();
    });

    try {
      const { user, assistant } = await store.send(
        scope,
        id,
        text,
        {
          onChunk: (delta) => send("chunk", { delta }),
          onTool: (info) => send("tool", info),
          onPill: (pill) => send("pill", pill),
          onRetryStatus: (info) => send("retry_status", info),
        },
        ac.signal,
        clientId,
      );
      send("done", { user, assistant });
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
      // Log server-side too — these errors used to vanish into the
      // SSE pipe and surface only as a UI overlay with no breadcrumbs.
      // Special-case spawn failures with extra context (cwd, binary,
      // syscall) since they're the most common opaque failure mode
      // (cwd missing, binary missing, permissions, etc).
      const errAny = err as { code?: string; syscall?: string; path?: string; spawnargs?: string[] } | undefined;
      if (errAny?.code === "ENOENT" || errAny?.code === "ENOTDIR" || errAny?.code === "EACCES") {
        console.error(
          `[chats] spawn failed: ${message} (code=${errAny.code} syscall=${errAny.syscall ?? "?"} path=${errAny.path ?? "?"})`,
        );
      } else {
        console.error(`[chats] send failed: ${message}`);
      }
      send("error", { message });
    } finally {
      res.end();
    }
  });
}

bindChatRoutes("/chats", () => ({ kind: "global" }));
bindChatRoutes("/projects/:slug/chats", (req) => ({
  kind: "project",
  slug: String(req.params.slug),
}));

// ---- Mutations ----

app.post("/v1/mutations/apply", async (req: Request, res: Response) => {
  const result = await applyMutation(req.body, applyCtx);
  if (result.ok) {
    res.json({ ok: true, kind: result.kind, result: result.result });
  } else {
    res.status(result.status).json({ ok: false, error: result.error });
  }
});

const server = app.listen(PORT, async () => {
  await ensureDir(dataRoot());
  await ensureBootstrapAdmin();
  await ensureBootstrapRules();
  console.log(
    `icarus server listening on :${PORT} ` +
      `(binary=${CURSOR_BIN}, cwd=${CURSOR_CWD}, model=${CURSOR_MODEL ?? "default"}, ` +
      `data=${dataRoot()})`,
  );
  void cursor.probe(cursorOpts).then(
    ({ version, auth }) => {
      console.log(`cursor-agent ${version} found, auth: ${auth}`);
      if (auth === "none") {
        console.warn(
          "No cursor-agent auth detected. Set CURSOR_API_KEY in .env or run " +
            "`cursor-agent login` to authenticate.",
        );
      }
    },
    (err) => {
      console.error(`cursor-agent unavailable: ${err instanceof Error ? err.message : err}`);
    },
  );
});

events.attach(server);

const shutdown = (signal: string) => {
  console.log(`\n${signal} received, shutting down...`);
  server.close(async () => {
    await closeAuthDb().catch(() => undefined);
    process.exit(0);
  });
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
