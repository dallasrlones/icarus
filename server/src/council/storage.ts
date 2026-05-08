import fs from "node:fs/promises";
import path from "node:path";
import { ensureDir, writeJson } from "../storage/json.js";
import { councilDir, councilRunFile } from "../storage/paths.js";
import type { CouncilRun, CouncilRunType } from "./types.js";

/**
 * Disk-backed council artifact persistence.
 *
 * One JSON file per run, named `<run_type>-<run_id>.json`. We don't
 * maintain a per-feature index file — `listRuns` scans the directory and
 * filters by filename prefix. With realistic run counts (a few dozen per
 * feature over its lifetime) that's plenty fast.
 *
 * Writes happen under the project lock so we don't tear an in-flight read
 * scan when a runner finalizes.
 */

export async function saveRun(run: CouncilRun): Promise<void> {
  const file = councilRunFile(run.project_slug, run.feature_id, run.type, run.id);
  await ensureDir(path.dirname(file));
  await writeJson(file, run);
}

export async function loadRun(
  slug: string,
  featureId: string,
  runType: CouncilRunType,
  runId: string,
): Promise<CouncilRun | null> {
  const file = councilRunFile(slug, featureId, runType, runId);
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw) as CouncilRun;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * List runs for a feature, newest first. Optionally filter by run type
 * and/or status.
 */
export async function listRuns(
  slug: string,
  featureId: string,
  filter?: { type?: CouncilRunType; status?: CouncilRun["status"] },
): Promise<CouncilRun[]> {
  const dir = councilDir(slug, featureId);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const runs: CouncilRun[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    if (filter?.type && !name.startsWith(`${filter.type}-`)) continue;
    try {
      const raw = await fs.readFile(path.join(dir, name), "utf8");
      const parsed = JSON.parse(raw) as CouncilRun;
      if (filter?.status && parsed.status !== filter.status) continue;
      runs.push(parsed);
    } catch {
      // Corrupt run file — skip rather than crash the listing.
    }
  }
  runs.sort((a, b) => b.started_at - a.started_at);
  return runs;
}

/** Most recent run of a given type for a feature, regardless of status. */
export async function latestRun(
  slug: string,
  featureId: string,
  type: CouncilRunType,
): Promise<CouncilRun | null> {
  const runs = await listRuns(slug, featureId, { type });
  return runs[0] ?? null;
}
