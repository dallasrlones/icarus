import type { CronJob } from "../domain.js";
import { readJsonOr, writeJson } from "./json.js";
import { cronFile } from "./paths.js";

/**
 * Disk-backed read/write for the global cron registry. Same shape as the
 * tools registry — single JSON file at the data root, serialized via
 * `globalLocks.run("cron", ...)`. The scheduler loop reads this every
 * minute and dispatches enabled jobs whose schedule matches the tick.
 */

interface CronFile {
  jobs: CronJob[];
}

const EMPTY: CronFile = { jobs: [] };

export async function readCronJobs(): Promise<CronJob[]> {
  const data = await readJsonOr<CronFile>(cronFile(), EMPTY);
  return Array.isArray(data.jobs) ? data.jobs : [];
}

export async function writeCronJobs(jobs: CronJob[]): Promise<void> {
  await writeJson(cronFile(), { jobs });
}
