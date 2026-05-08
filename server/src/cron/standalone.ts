import fs from "node:fs/promises";
import { events } from "../events.js";
import { shortId } from "../ids.js";
import { createChat, sendTurn, type CursorOptions } from "../cursor.js";
import { readTools } from "../storage/tools.js";
import { renderTool } from "../tools/render.js";
import {
  cronTranscriptsDir,
  cronWorkspaceDir,
} from "../storage/paths.js";
import {
  appendRun,
  appendTranscriptLine,
  ensureCronStateDir,
  transcriptBytes,
} from "../storage/cron_runs.js";
import type { CronJob, CronRun } from "../domain.js";

/**
 * Standalone cron runner — spawns `cursor-agent` directly in the
 * cron's owned workspace and persists the run history.
 *
 * Why bypass the queue worker:
 *   - Tasks are intrinsically project-scoped in our domain types;
 *     bending the queue worker to support project-less tasks would
 *     touch the picker, the lease/scope manager, the storage layer,
 *     and the queue events. Way more surface area than the feature
 *     justifies.
 *   - Cron jobs are by definition serialized — one tick at a time per
 *     job — so we don't need queue-style concurrency control.
 *   - Self-contained run history (`store/_cron/<slug>/runs.jsonl`)
 *     maps 1:1 to ticks, which makes "what did this hourly job do at
 *     3am?" a one-line answer without joining task tables.
 *
 * Concurrency: a per-cron-slug mutex prevents overlapping ticks. If a
 * tick fires while the previous run is still going, the new tick is
 * skipped (last_run_at is updated by the scheduler regardless, so
 * we don't fire the same minute twice).
 */

const inflight = new Map<string, Promise<unknown>>();

export interface StandaloneRunResult {
  ok: boolean;
  run: CronRun;
  /** Final assistant text, concatenated across stream deltas. */
  text: string;
}

export interface StandaloneRunDeps {
  cursorOpts: CursorOptions;
  /** Root under which `_cron/<slug>/` is created (the cron's cwd). */
  workspaceRoot: string;
}

export async function runStandaloneCron(
  job: CronJob,
  deps: StandaloneRunDeps,
): Promise<StandaloneRunResult> {
  if (job.target.kind !== "standalone") {
    throw new Error(`runStandaloneCron called with non-standalone target: ${job.target.kind}`);
  }
  if (!job.slug) {
    // Backfill defensively. The applicator now always sets a slug, but
    // pre-Phase-23 cron jobs persisted without one. Use the job id as
    // a stable fallback so we don't collide with anything.
    throw new Error(`standalone cron ${job.id} has no slug — re-save the job to backfill`);
  }
  const slug = job.slug;

  // Per-slug mutex. If a previous run is still going, skip this tick
  // and surface a clear "skipped" run row so it's visible in the UI.
  if (inflight.has(slug)) {
    const skipped: CronRun = {
      run_id: shortId("run"),
      cron_id: job.id,
      cron_slug: slug,
      started_at: Date.now(),
      ended_at: Date.now(),
      status: "error",
      duration_ms: 0,
      error: "skipped: previous run still in progress",
      transcript_bytes: 0,
    };
    await appendRun(skipped);
    return { ok: false, run: skipped, text: "" };
  }

  const work = doRun(job, slug, deps);
  inflight.set(slug, work);
  try {
    return await work;
  } finally {
    inflight.delete(slug);
  }
}

async function doRun(
  job: CronJob,
  slug: string,
  deps: StandaloneRunDeps,
): Promise<StandaloneRunResult> {
  if (job.target.kind !== "standalone") {
    throw new Error("unreachable");
  }
  const target = job.target;
  const runId = shortId("run");
  const startedAt = Date.now();

  // 1. Ensure dirs exist (mkdir -p; idempotent).
  const workspace = cronWorkspaceDir(deps.workspaceRoot, slug);
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(cronTranscriptsDir(slug), { recursive: true });
  await ensureCronStateDir(slug);

  // 2. Resolve the prompt — inline overrides Tool reference (schema
  //    enforces XOR but we double-check for clarity).
  let prompt: string;
  let promptSource: "inline" | "tool" = "inline";
  let toolName: string | undefined;
  if (target.prompt) {
    prompt = target.prompt;
  } else if (target.tool_id) {
    const tools = await readTools();
    const tool = tools.find((t) => t.id === target.tool_id);
    if (!tool) {
      const errored: CronRun = {
        run_id: runId,
        cron_id: job.id,
        cron_slug: slug,
        started_at: startedAt,
        ended_at: Date.now(),
        status: "error",
        duration_ms: Date.now() - startedAt,
        error: `tool ${target.tool_id} not found`,
        transcript_bytes: 0,
      };
      await appendRun(errored);
      broadcastRun(errored);
      return { ok: false, run: errored, text: "" };
    }
    const rendered = renderTool(tool, target.args ?? {});
    prompt = rendered.text;
    promptSource = "tool";
    toolName = tool.name;
  } else {
    const errored: CronRun = {
      run_id: runId,
      cron_id: job.id,
      cron_slug: slug,
      started_at: startedAt,
      ended_at: Date.now(),
      status: "error",
      duration_ms: 0,
      error: "no prompt or tool reference (corrupt cron job)",
      transcript_bytes: 0,
    };
    await appendRun(errored);
    broadcastRun(errored);
    return { ok: false, run: errored, text: "" };
  }

  // 3. Stamp a header line into the transcript so the user can reread
  //    runs in `tail -f` without reaching for the cron registry to
  //    figure out what was scheduled.
  await appendTranscriptLine(slug, runId, {
    kind: "header",
    cron_id: job.id,
    cron_slug: slug,
    cron_name: job.name,
    schedule: job.schedule,
    prompt_source: promptSource,
    tool_name: toolName,
    prompt_preview: prompt.slice(0, 600),
    workspace,
    started_at: startedAt,
  });

  broadcastEvent("cron_run_started", {
    cron_id: job.id,
    cron_slug: slug,
    run_id: runId,
    started_at: startedAt,
  });

  // 4. Spawn cursor-agent with the cron's workspace as cwd. We mirror
  //    `runOneShot` (one fresh chat, send the rendered prompt, collect
  //    deltas) but stream events to the transcript so the UI can
  //    render the run as it happens.
  const runOpts: CursorOptions = { ...deps.cursorOpts, cwd: workspace };
  let text = "";
  let durationMs: number | undefined;
  let runError: string | undefined;
  try {
    const chatId = await createChat(runOpts);
    await appendTranscriptLine(slug, runId, { kind: "init", chat_id: chatId });
    for await (const ev of sendTurn(runOpts, chatId, prompt)) {
      switch (ev.kind) {
        case "init":
          await appendTranscriptLine(slug, runId, { kind: "init", model: ev.model });
          break;
        case "delta":
          text += ev.text;
          await appendTranscriptLine(slug, runId, { kind: "delta", text: ev.text });
          break;
        case "tool":
          await appendTranscriptLine(slug, runId, {
            kind: "tool",
            phase: ev.phase,
            name: ev.name,
            detail: ev.detail,
          });
          break;
        case "result":
          durationMs = ev.durationMs;
          await appendTranscriptLine(slug, runId, { kind: "result", duration_ms: ev.durationMs });
          break;
        case "error":
          runError = ev.message;
          await appendTranscriptLine(slug, runId, { kind: "error", message: ev.message });
          break;
      }
    }
  } catch (err) {
    runError = err instanceof Error ? err.message : String(err);
    await appendTranscriptLine(slug, runId, { kind: "error", message: runError });
  }

  // 5. Persist the run row and broadcast.
  const endedAt = Date.now();
  const tBytes = await transcriptBytes(slug, runId);
  const run: CronRun = {
    run_id: runId,
    cron_id: job.id,
    cron_slug: slug,
    started_at: startedAt,
    ended_at: endedAt,
    status: runError ? "error" : "ok",
    duration_ms: durationMs ?? endedAt - startedAt,
    error: runError ? runError.slice(0, 500) : undefined,
    transcript_bytes: tBytes,
  };
  await appendRun(run);
  broadcastRun(run);

  return { ok: !runError, run, text };
}

function broadcastRun(run: CronRun): void {
  broadcastEvent(run.status === "ok" ? "cron_run_completed" : "cron_run_failed", {
    cron_id: run.cron_id,
    cron_slug: run.cron_slug,
    run_id: run.run_id,
    status: run.status,
    started_at: run.started_at,
    ended_at: run.ended_at,
    duration_ms: run.duration_ms,
    error: run.error,
  });
}

function broadcastEvent(kind: string, payload: Record<string, unknown>): void {
  events.broadcast({
    type: "mutation_applied",
    kind,
    payload,
    result: null,
    ts: Date.now(),
  });
}
