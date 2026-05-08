import type { Architecture, Feature, Flow, Task } from "../domain.js";
import { readJsonOr, writeJson } from "./json.js";
import { projectFile } from "./paths.js";

/**
 * Disk-backed reads/writes for the per-project entity JSON files. All
 * writes must happen inside the matching `projectLocks.run(slug, ...)`
 * scope so concurrent applicators can't lose updates.
 *
 * Single source-of-truth is the on-disk JSON; we hold no in-process cache
 * (the lock + read+write pattern is plenty fast for the workload).
 */

interface FeaturesFile { features: Feature[] }
interface FlowsFile { flows: Flow[] }
interface TasksFile { tasks: Task[] }

const EMPTY_FEATURES: FeaturesFile = { features: [] };
const EMPTY_FLOWS: FlowsFile = { flows: [] };
const EMPTY_TASKS: TasksFile = { tasks: [] };

// ---- Features ----

export async function readFeatures(slug: string): Promise<Feature[]> {
  const data = await readJsonOr<FeaturesFile>(projectFile(slug, "features.json"), EMPTY_FEATURES);
  return data.features ?? [];
}

export async function writeFeatures(slug: string, features: Feature[]): Promise<void> {
  await writeJson(projectFile(slug, "features.json"), { features });
}

// ---- Flows (one per feature) ----

export async function readFlows(slug: string): Promise<Flow[]> {
  const data = await readJsonOr<FlowsFile>(projectFile(slug, "flows.json"), EMPTY_FLOWS);
  return data.flows ?? [];
}

export async function writeFlows(slug: string, flows: Flow[]): Promise<void> {
  await writeJson(projectFile(slug, "flows.json"), { flows });
}

/** Get-or-create the flow for a feature; returned by reference into the array. */
export function ensureFlow(flows: Flow[], featureId: string): Flow {
  let flow = flows.find((f) => f.feature_id === featureId);
  if (!flow) {
    flow = { feature_id: featureId, nodes: [], edges: [], updated_at: Date.now() };
    flows.push(flow);
  }
  return flow;
}

// ---- Tasks ----

export async function readTasks(slug: string): Promise<Task[]> {
  const data = await readJsonOr<TasksFile>(projectFile(slug, "tasks.json"), EMPTY_TASKS);
  return data.tasks ?? [];
}

export async function writeTasks(slug: string, tasks: Task[]): Promise<void> {
  await writeJson(projectFile(slug, "tasks.json"), { tasks });
}

// ---- Architecture (Phase 8) ----

const EMPTY_ARCHITECTURE: Architecture = { services: [], edges: [], updated_at: 0 };

export async function readArchitecture(slug: string): Promise<Architecture> {
  const data = await readJsonOr<Architecture>(
    projectFile(slug, "architecture.json"),
    EMPTY_ARCHITECTURE,
  );
  // Defensive: tolerate the legacy `{ services: {} }` shape that early
  // create_project initializers wrote before we adopted the array-based
  // schema. Coerce to an empty architecture so the UI doesn't blow up.
  if (!Array.isArray(data.services)) {
    return { ...EMPTY_ARCHITECTURE };
  }
  return {
    services: data.services,
    edges: Array.isArray(data.edges) ? data.edges : [],
    updated_at: data.updated_at ?? 0,
    approved_at: typeof data.approved_at === "number" ? data.approved_at : undefined,
  };
}

export async function writeArchitecture(slug: string, arch: Architecture): Promise<void> {
  await writeJson(projectFile(slug, "architecture.json"), arch);
}
