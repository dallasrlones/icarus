import fs from "node:fs/promises";
import { activityFile, globalActivityFile } from "./paths.js";
import { appendJsonl, isNotFound } from "./json.js";

export interface ActivityEntry {
  ts: number;
  kind: string;
  scope: { kind: "global" } | { kind: "project"; slug: string };
  payload: unknown;
  result?: unknown;
}

export async function appendActivity(entry: ActivityEntry): Promise<void> {
  const file =
    entry.scope.kind === "project"
      ? activityFile(entry.scope.slug)
      : globalActivityFile();
  await appendJsonl(file, entry);
}

/** Tail the last N activity entries from a project's log. */
export async function tailProjectActivity(slug: string, limit = 50): Promise<ActivityEntry[]> {
  return await tailJsonl(activityFile(slug), limit);
}

export async function tailGlobalActivity(limit = 50): Promise<ActivityEntry[]> {
  return await tailJsonl(globalActivityFile(), limit);
}

async function tailJsonl(file: string, limit: number): Promise<ActivityEntry[]> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }
  const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
  const slice = lines.slice(-limit);
  const out: ActivityEntry[] = [];
  for (const line of slice) {
    try {
      out.push(JSON.parse(line) as ActivityEntry);
    } catch {
      // skip malformed line — append-only log; don't fail the whole read
    }
  }
  return out;
}
