import type { Feature, Task } from "../domain.js";
import { readFeatures, readTasks } from "../storage/entities.js";
import { readFleet } from "../storage/fleet.js";
import { readQuestions } from "./storage.js";
import type { QueueScope } from "./types.js";

/**
 * Cross-project task picker.
 *
 * The picker walks every active project, collects tasks that are eligible
 * for the queue, and returns them in priority/created-at order. Eligibility:
 *   - status === "todo" (no in_progress, done, stale)
 *   - !proposed (un-approved council proposals never run)
 *   - if feature_id is set: parent feature.status ∈ {planned, in_progress}
 *     (planned features unblock all their tasks; in_progress means the
 *     queue already started shipping them)
 *   - the task is not currently blocking a question (any open question
 *     for that task pauses the task until answered)
 *   - Phase 9: not currently leased by another worker, and its
 *     `resource_scope` (if set) doesn't collide with an active lease.
 *
 * Ad-hoc tasks (no feature_id) are always eligible.
 *
 * Scope: if the QueueScope has a project_slug set, we only consider tasks
 * for that project. Otherwise we walk the whole fleet.
 */

export interface PickerExcludes {
  /** Task ids currently held by other workers. */
  taskIds?: ReadonlySet<string>;
  /** Resource scopes currently held by other workers. */
  scopes?: ReadonlySet<string>;
}

export interface PickerCandidate {
  task: Task;
  feature: Feature | null;
}

const ELIGIBLE_FEATURE_STATUSES: ReadonlySet<Feature["status"]> = new Set([
  "planned",
  "in_progress",
]);

export async function listEligibleTasks(
  scope: QueueScope,
  excludes: PickerExcludes = {},
): Promise<PickerCandidate[]> {
  const fleet = await readFleet();
  const slugs = scope.project_slug
    ? fleet.projects.filter((p) => p.slug === scope.project_slug && p.status !== "archived").map((p) => p.slug)
    : fleet.projects.filter((p) => p.status !== "archived").map((p) => p.slug);

  const candidates: PickerCandidate[] = [];
  const excludeIds = excludes.taskIds ?? new Set<string>();
  const excludeScopes = excludes.scopes ?? new Set<string>();

  for (const slug of slugs) {
    const [features, tasks, questions] = await Promise.all([
      readFeatures(slug),
      readTasks(slug),
      readQuestions(slug),
    ]);
    const featureById = new Map(features.map((f) => [f.id, f]));
    const blockedTaskIds = new Set(
      questions.filter((q) => q.status === "open").map((q) => q.task_id),
    );

    for (const t of tasks) {
      if (t.status !== "todo") continue;
      if (t.proposed) continue;
      if (blockedTaskIds.has(t.id)) continue;
      if (excludeIds.has(t.id)) continue;
      if (t.resource_scope && excludeScopes.has(t.resource_scope)) continue;

      let feature: Feature | null = null;
      if (t.feature_id) {
        const f = featureById.get(t.feature_id);
        if (!f) continue; // dangling reference — skip
        if (!ELIGIBLE_FEATURE_STATUSES.has(f.status)) continue;
        feature = f;
      }
      candidates.push({ task: t, feature });
    }
  }

  candidates.sort((a, b) => {
    const pa = a.task.priority ?? 0;
    const pb = b.task.priority ?? 0;
    if (pb !== pa) return pb - pa; // higher priority first
    return a.task.created_at - b.task.created_at; // older first
  });

  return candidates;
}

export async function pickNext(
  scope: QueueScope,
  excludes: PickerExcludes = {},
): Promise<PickerCandidate | null> {
  const list = await listEligibleTasks(scope, excludes);
  return list[0] ?? null;
}
