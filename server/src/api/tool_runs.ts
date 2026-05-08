import type { Task, Tool } from "../domain.js";
import { listTaskRuns, type TaskRunRecord } from "../queue/storage.js";
import { readTasks } from "../storage/entities.js";
import { readFleet } from "../storage/fleet.js";

/**
 * Tool runs are a thin "callable API" wrapper around the existing task /
 * queue infrastructure. A tool run is just a Task that carries a
 * `tool_id` + `tool_args`; the queue worker picks it up, runs the
 * rendered prompt, and writes a TaskRunRecord. This module exposes
 * helpers for the `/v1/tools/:ref/run` and `/v1/tool_runs/:run_id`
 * endpoints so the wire shape stays consistent and the routes file in
 * `index.ts` stays focused on plumbing.
 *
 * Conventions:
 *   - `run_id == task_id`. We don't expose `TaskRunRecord.id` to API
 *     callers because retries and re-runs are rare in tool-run flows
 *     and the task id is the more durable handle.
 *   - We always derive the *latest* TaskRunRecord per task (the worker
 *     saves them sorted, but `listTaskRuns` re-sorts newest-first).
 *   - Raw output is truncated to a fixed budget on the way out — full
 *     transcripts are still available via `/projects/:slug/tasks/:id/runs`.
 */

const RAW_OUTPUT_EXCERPT_BYTES = 16 * 1024;

export type ToolRunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "awaiting_question";

export interface ToolView {
  id: string;
  slug: string;
  name: string;
}

export interface ToolRunArtifact {
  path: string;
  kind?: string;
}

export interface ToolRunView {
  /** Stable handle for polling. Same value as `task_id`. */
  run_id: string;
  task_id: string;
  project_slug: string;
  tool: ToolView;
  status: ToolRunStatus;
  args: Record<string, string>;
  started_at: number;
  finished_at?: number;
  result?: {
    summary?: string;
    artifacts?: ToolRunArtifact[];
  };
  error?: string;
  /** Last 16 KiB of raw cursor-agent output, for quick debugging. */
  raw_output_excerpt?: string;
}

export function toolView(tool: Tool): ToolView {
  return { id: tool.id, slug: tool.slug, name: tool.name };
}

/**
 * Locate a task by id without a project hint. Tool runs are addressed by
 * task id alone (there's no central index by id), so we walk the fleet.
 * Cheap at our scale — single-user, dozens of projects, hundreds of
 * tasks per project — and avoids inventing a new index.
 */
export async function findTaskAcrossProjects(
  taskId: string,
): Promise<{ task: Task; project_slug: string } | null> {
  const fleet = await readFleet();
  for (const p of fleet.projects) {
    const tasks = await readTasks(p.slug);
    const task = tasks.find((t) => t.id === taskId);
    if (task) return { task, project_slug: p.slug };
  }
  return null;
}

function mapRunStatus(record: TaskRunRecord | undefined, task: Task): ToolRunStatus {
  if (record) {
    switch (record.status) {
      case "completed":
        return "completed";
      case "failed":
        return "failed";
      case "running":
        return "running";
      case "awaiting_question":
        return "awaiting_question";
      case "cancelled":
        return "cancelled";
    }
  }
  // No run record yet (just queued, or running but not yet flushed).
  switch (task.status) {
    case "todo":
      return "queued";
    case "in_progress":
      return "running";
    case "done":
      return "completed";
    case "stale":
      return "cancelled";
    default:
      return "queued";
  }
}

/**
 * Pull the structured result out of a `complete_task` pill, if the run
 * produced one. Falls back to undefined — callers should treat the
 * absence of a `result` field as "agent didn't emit a structured
 * summary" rather than as an error.
 */
function extractResult(
  record: TaskRunRecord | undefined,
): ToolRunView["result"] | undefined {
  if (!record) return undefined;
  const pill = record.pills.find((p) => p.kind === "complete_task");
  if (!pill || !pill.result || typeof pill.result !== "object") return undefined;
  const r = pill.result as {
    summary?: string;
    artifacts?: ToolRunArtifact[];
  };
  if (!r.summary && (!r.artifacts || r.artifacts.length === 0)) return undefined;
  return { summary: r.summary, artifacts: r.artifacts };
}

export async function buildToolRunView(
  task: Task,
  projectSlug: string,
  tool: Tool | null,
): Promise<ToolRunView> {
  const runs = await listTaskRuns(projectSlug, task.id);
  const latest = runs[0];
  return {
    run_id: task.id,
    task_id: task.id,
    project_slug: projectSlug,
    tool: tool
      ? toolView(tool)
      : {
          id: task.tool_id ?? "",
          slug: "",
          name: task.title ?? "(unknown tool)",
        },
    status: mapRunStatus(latest, task),
    args: task.tool_args ?? {},
    started_at: latest?.started_at ?? task.created_at,
    finished_at: latest?.finished_at,
    result: extractResult(latest),
    error: latest?.error,
    raw_output_excerpt: latest?.raw_output
      ? latest.raw_output.slice(-RAW_OUTPUT_EXCERPT_BYTES)
      : undefined,
  };
}

/**
 * List every task across the fleet that was created via a given tool.
 * Used by `GET /v1/tools/:ref/runs`. Optional `projectSlug` narrows the
 * scan; otherwise we walk every project. Sorted newest-first.
 */
export async function listToolRunsForTool(
  toolId: string,
  projectSlug?: string,
): Promise<Array<{ task: Task; project_slug: string }>> {
  const fleet = await readFleet();
  const slugs = projectSlug ? [projectSlug] : fleet.projects.map((p) => p.slug);
  const out: Array<{ task: Task; project_slug: string }> = [];
  for (const slug of slugs) {
    const tasks = await readTasks(slug);
    for (const t of tasks) {
      if (t.tool_id === toolId) out.push({ task: t, project_slug: slug });
    }
  }
  out.sort((a, b) => b.task.created_at - a.task.created_at);
  return out;
}
