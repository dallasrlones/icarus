import { events } from "../events.js";
import { shortId } from "../ids.js";
import { applyMutation } from "../mutations/apply.js";
import type { ApplyContext } from "../mutations/applicators.js";
import { readCronJobs, writeCronJobs } from "../storage/cron.js";
import { globalLocks } from "../storage/locks.js";
import type { CronJob } from "../domain.js";
import type { CursorOptions } from "../cursor.js";
import { matches, parse } from "./expr.js";
import { runStandaloneCron } from "./standalone.js";

/**
 * Single-process cron scheduler.
 *
 * Strategy: align to the next minute boundary, then poll every 60s. On
 * each tick we read the current cron registry, evaluate enabled jobs
 * against the tick's clock components, and dispatch any matches. We
 * intentionally do not use setInterval drift compensation more
 * sophisticated than a re-align after each tick — accuracy within
 * a second of the wall clock is plenty for our use case.
 *
 * Idempotency: each job's `last_run_at` is updated to the tick's start
 * time. If the server is paused/resumed and we land on the same minute
 * twice, we skip dispatching when last_run_at already covers this tick.
 *
 * Dispatch is non-blocking: tool/queue starts return as soon as they're
 * accepted by the queue worker; cron does not wait for the work itself
 * to finish.
 */

let started = false;
let nextTimer: NodeJS.Timeout | null = null;
let applyCtxRef: ApplyContext | null = null;
let cursorOptsRef: CursorOptions | null = null;

export function initCronScheduler(opts: {
  applyCtx: ApplyContext;
  /**
   * Phase 23: needed by the `standalone` target dispatch path so we
   * can spawn cursor-agent directly in the cron's owned workspace
   * without going through the queue worker.
   */
  cursorOpts: CursorOptions;
}): void {
  if (started) return;
  started = true;
  applyCtxRef = opts.applyCtx;
  cursorOptsRef = opts.cursorOpts;
  scheduleNextTick();
}

export function stopCronScheduler(): void {
  if (nextTimer) clearTimeout(nextTimer);
  nextTimer = null;
  started = false;
}

function scheduleNextTick(): void {
  const now = new Date();
  const ms =
    60_000 -
    (now.getSeconds() * 1000 + now.getMilliseconds()) +
    50; // 50ms cushion to land just past the minute boundary
  nextTimer = setTimeout(() => {
    void runTick().finally(() => {
      if (started) scheduleNextTick();
    });
  }, ms);
}

async function runTick(): Promise<void> {
  const tickStart = new Date();
  // Snap to minute precision for last_run_at comparisons.
  tickStart.setSeconds(0, 0);
  const tickKey = tickStart.getTime();

  let jobs: CronJob[];
  try {
    jobs = await readCronJobs();
  } catch (err) {
    console.error("[cron] failed to read registry:", err);
    return;
  }

  const dispatched: CronJob[] = [];
  for (const job of jobs) {
    if (!job.enabled) continue;
    if (job.last_run_at && job.last_run_at >= tickKey) continue; // already fired this minute
    let parsed;
    try {
      parsed = parse(job.schedule);
    } catch (err) {
      console.warn(`[cron] job ${job.id} (${job.name}) has invalid schedule: ${err}`);
      continue;
    }
    if (!matches(tickStart, parsed)) continue;
    dispatched.push(job);
  }

  for (const job of dispatched) {
    try {
      await executeCronJob(job, { manual: false, tickKey });
    } catch (err) {
      console.error(`[cron] dispatch failed for job ${job.id}:`, err);
    }
  }
}

/**
 * Run a job's target now. Used by both the tick loop and the
 * `run_cron_now` applicator. Updates `last_run_at` / `last_status` /
 * `last_error` on the job, persists the change, and broadcasts a
 * mutation_applied event so the frontend can refresh.
 */
export async function executeCronJob(
  job: CronJob,
  opts: { manual: boolean; tickKey?: number },
): Promise<{ ok: boolean; cron_id: string; manual: boolean; mutation?: unknown; error?: string }> {
  if (!applyCtxRef) {
    throw new Error("cron scheduler not initialized");
  }
  const target = job.target;

  // Phase 23: standalone targets bypass the project queue entirely.
  // The runner spawns cursor-agent directly in the cron's owned
  // workspace and persists transcripts + run history under
  // `store/_cron/<slug>/`. See `cron/standalone.ts` for the
  // rationale; in short: tasks are intrinsically project-scoped, and
  // a fully self-contained run history maps better to "what did this
  // hourly job do at 3am?" than rummaging through the project queue.
  if (target.kind === "standalone") {
    if (!cursorOptsRef) {
      throw new Error("cron scheduler not initialized (cursorOpts missing)");
    }
    let runResult;
    try {
      runResult = await runStandaloneCron(job, {
        cursorOpts: cursorOptsRef,
        workspaceRoot: applyCtxRef.workspaceRoot,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await updateJobAfterRun(job.id, {
        last_run_at: opts.tickKey ?? Date.now(),
        last_status: "error",
        last_error: msg,
      });
      return { ok: false, cron_id: job.id, manual: opts.manual, error: msg };
    }
    await updateJobAfterRun(job.id, {
      last_run_at: opts.tickKey ?? Date.now(),
      last_status: runResult.run.status,
      last_error: runResult.run.error,
    });
    return {
      ok: runResult.ok,
      cron_id: job.id,
      manual: opts.manual,
      mutation: runResult.ok ? { run_id: runResult.run.run_id } : undefined,
      error: runResult.run.error,
    };
  }

  // Two-stage dispatch is only needed for the `task` target with
  // auto_start: we apply `add_task` first, then optionally
  // `start_task` against the returned task id. Stage 1 success is
  // what we report on the job — the task is durable on disk by then;
  // a stage-2 failure just means the queue worker will pick it up
  // later instead of right now.
  const envelopes: unknown[] = [];
  if (target.kind === "tool") {
    envelopes.push({
      kind: "run_tool",
      payload: {
        tool_id: target.tool_id,
        project_slug: target.project_slug,
        args: target.args ?? {},
        priority: target.priority,
        title: `cron: ${job.name}`,
        auto_start: true,
      },
      client_id: shortId("cron"),
    });
  } else if (target.kind === "queue") {
    envelopes.push({
      kind: "start_queue",
      payload: target.project_slug ? { project_slug: target.project_slug } : {},
      client_id: shortId("cron"),
    });
  } else if (target.kind === "task") {
    envelopes.push({
      kind: "add_task",
      payload: {
        project_slug: target.project_slug,
        title: target.title,
        description: target.description,
        priority: target.priority,
        feature_id: target.feature_id,
      },
      client_id: shortId("cron"),
    });
  } else {
    throw new Error(`unknown cron target kind: ${(target as { kind: string }).kind}`);
  }

  // Stage 1
  const result = await applyMutation(envelopes[0], applyCtxRef);

  // Stage 2: only for `task` + auto_start. Best-effort; a failure here
  // doesn't roll back stage 1 — the task is durably created and the
  // queue worker will pick it up on its next sweep regardless.
  let secondary: unknown;
  if (
    result.ok &&
    target.kind === "task" &&
    target.auto_start &&
    typeof result.result === "object" &&
    result.result !== null &&
    "task" in (result.result as Record<string, unknown>)
  ) {
    const created = (result.result as { task?: { id?: string } }).task;
    if (created?.id) {
      const startResult = await applyMutation(
        {
          kind: "start_task",
          payload: { project_slug: target.project_slug, task_id: created.id },
          client_id: shortId("cron"),
        },
        applyCtxRef,
      );
      secondary = startResult.ok
        ? { auto_started: true, task_id: created.id }
        : { auto_started: false, task_id: created.id, error: startResult.error };
    }
  }

  await updateJobAfterRun(job.id, {
    last_run_at: opts.tickKey ?? Date.now(),
    last_status: result.ok ? "ok" : "error",
    last_error: result.ok ? undefined : result.error,
  });

  events.broadcast({
    type: "mutation_applied",
    kind: result.ok ? `cron_dispatched:${target.kind}` : "cron_dispatch_failed",
    payload: { cron_id: job.id, manual: opts.manual, target: target.kind },
    result: result.ok
      ? secondary
        ? { ...(result.result as object), secondary }
        : result.result
      : { error: result.error },
    ts: Date.now(),
  });

  return {
    ok: result.ok,
    cron_id: job.id,
    manual: opts.manual,
    mutation: result.ok ? result.result : undefined,
    error: result.ok ? undefined : result.error,
  };
}

async function updateJobAfterRun(
  cronId: string,
  patch: { last_run_at: number; last_status: "ok" | "error"; last_error?: string },
): Promise<void> {
  await globalLocks.run("cron", async () => {
    const jobs = await readCronJobs();
    const job = jobs.find((j) => j.id === cronId);
    if (!job) return;
    job.last_run_at = patch.last_run_at;
    job.last_status = patch.last_status;
    job.last_error = patch.last_error;
    job.updated_at = Date.now();
    await writeCronJobs(jobs);
  });
}
