import fs from "node:fs/promises";
import path from "node:path";
import type { CronRun } from "../domain.js";
import {
  cronRunsFile,
  cronStateDir,
  cronTranscriptFile,
  cronTranscriptsDir,
} from "./paths.js";

/**
 * Per-cron run history + transcript persistence for `kind: "standalone"`
 * cron jobs.
 *
 * Why JSONL (not a single JSON file): runs append once per tick, never
 * mutate, and the runs list is read append-tail-first by the UI. Append
 * + read-and-parse-line-by-line is O(1) for writes; rotation is a
 * single rewrite when the cap is exceeded. We avoid SQLite here because
 * the working set is small (≤ MAX_RUNS rows × small payload) and the
 * file shows up nicely in `cat`/`tail -f` for debugging.
 *
 * Concurrency: cron tick + `run_cron_now` are serialized per-cron-job
 * by the runner's slug-keyed mutex, so we don't add another lock here.
 * Cross-cron writes go to different files.
 *
 * Disk layout (lives under `cronStateDir(slug)`):
 *   runs.jsonl                    (one CronRun row per line)
 *   transcripts/<run_id>.jsonl    (line-by-line cursor-agent events)
 */

/** User-configurable retention; chosen at "Last 1000 runs" via Phase-23 design. */
const MAX_RUNS = 1_000;

export async function ensureCronStateDir(cronSlug: string): Promise<void> {
  await fs.mkdir(cronTranscriptsDir(cronSlug), { recursive: true });
}

/**
 * Append a completed run row. After append, if the file exceeds
 * MAX_RUNS lines, rewrite it keeping only the most recent MAX_RUNS
 * rows. The same trim deletes orphaned transcripts (any transcript
 * whose run_id is no longer in the kept set), which prevents the
 * transcripts dir from growing unboundedly when ticks fire frequently.
 */
export async function appendRun(run: CronRun): Promise<void> {
  await ensureCronStateDir(run.cron_slug);
  const file = cronRunsFile(run.cron_slug);
  await fs.appendFile(file, `${JSON.stringify(run)}\n`, "utf8");
  await rotateIfNeeded(run.cron_slug);
}

export async function readRuns(cronSlug: string): Promise<CronRun[]> {
  const file = cronRunsFile(cronSlug);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: CronRun[] = [];
  for (const line of raw.split(/\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as CronRun);
    } catch {
      // Skip malformed rows rather than crashing the read — a half-flushed
      // line during an unclean shutdown is the only realistic cause and
      // it's not worth losing the entire history over.
    }
  }
  return out;
}

/**
 * Append a single transcript event line for an in-flight run. Caller
 * is responsible for serializing writes per-run (the standalone runner
 * does this naturally — one writer per cursor-agent invocation).
 */
export async function appendTranscriptLine(
  cronSlug: string,
  runId: string,
  payload: unknown,
): Promise<void> {
  await ensureCronStateDir(cronSlug);
  const file = cronTranscriptFile(cronSlug, runId);
  await fs.appendFile(file, `${JSON.stringify(payload)}\n`, "utf8");
}

export async function readTranscript(
  cronSlug: string,
  runId: string,
): Promise<string> {
  const file = cronTranscriptFile(cronSlug, runId);
  try {
    return await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
}

/**
 * Filesystem byte-size of an in-progress or completed transcript.
 * Cheap enough to call from the runner just before persisting the
 * CronRun row so the UI can show "X KB transcript" without re-reading.
 */
export async function transcriptBytes(
  cronSlug: string,
  runId: string,
): Promise<number> {
  const file = cronTranscriptFile(cronSlug, runId);
  try {
    const stat = await fs.stat(file);
    return stat.size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
}

async function rotateIfNeeded(cronSlug: string): Promise<void> {
  const runs = await readRuns(cronSlug);
  if (runs.length <= MAX_RUNS) return;
  const kept = runs.slice(runs.length - MAX_RUNS);
  const keptIds = new Set(kept.map((r) => r.run_id));

  // Rewrite runs.jsonl with the kept window only. We write to a temp
  // file and rename so a crash mid-rotation doesn't truncate history.
  const file = cronRunsFile(cronSlug);
  const tmp = `${file}.rotate.tmp`;
  const body = kept.map((r) => JSON.stringify(r)).join("\n") + "\n";
  await fs.writeFile(tmp, body, "utf8");
  await fs.rename(tmp, file);

  // Sweep transcripts whose run_id fell out of the window.
  const dir = cronTranscriptsDir(cronSlug);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return;
  }
  await Promise.all(
    entries.map(async (name) => {
      if (!name.endsWith(".jsonl")) return;
      const runId = name.slice(0, -".jsonl".length);
      if (keptIds.has(runId)) return;
      try {
        await fs.unlink(path.join(dir, name));
      } catch {
        // Best-effort.
      }
    }),
  );
}

// `cronStateDir` is referenced for type elision in some callers but
// not consumed here directly — re-exporting keeps imports tidy.
export { cronStateDir };
