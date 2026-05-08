/**
 * Council artifact shapes.
 *
 * v1 is a single cursor-agent run with a Chair-style multi-lens prompt;
 * the agent is asked to reply with one JSON envelope containing the five
 * lens reports plus a Chair summary. Phase 9 swaps the runner for true
 * 5-parallel runs without changing this artifact shape.
 *
 * Persisted on disk at:
 *   store/projects/<slug>/council/<feature_id>/<run_type>-<run_id>.json
 */

export type CouncilRunType =
  | "flow_review"
  | "task_planning"
  // Phase 18: project-scoped architecture review. The chair's
  // verdict drives `approve_architecture` automatically when it
  // returns `approve` / `approve_with_notes`. Persisted under a
  // sentinel feature_id of `_arch` since the run is project-wide,
  // not feature-scoped.
  | "architecture_review";

/** Sentinel feature id for project-scoped runs (architecture_review). */
export const PROJECT_SCOPED_FEATURE_ID = "_arch";

export type CouncilRunStatus =
  | "pending"   // queued, runner hasn't started yet
  | "running"   // cursor-agent in flight
  | "completed" // result captured & validated
  | "failed";   // runner errored or response unparseable

/**
 * Phase 14: lens id is now a free-form string (any persona key).
 * The default keys are still `product | ux | architecture | security
 * | operability` and DEFAULT_PERSONAS in the persona registry seeds
 * them. Custom personas can replace any default key (same string,
 * different prompt) or add new keys (`marketing`, `legal`, etc).
 *
 * The narrower union is kept exported as `DefaultLensId` for the
 * places that still want compile-time guarantees about defaults
 * (e.g. UI tab labels). General code should use `string`.
 */
export type LensId = string;
export type DefaultLensId = "product" | "ux" | "architecture" | "security" | "operability";

export type Severity = "info" | "minor" | "major" | "blocking";

/** Chair verdict mirrors what individual lenses can return. */
export type Verdict = "approve" | "approve_with_notes" | "request_changes";

export interface CouncilFinding {
  severity: Severity;
  summary: string;
  /** If true, must be addressed before approval. */
  must_address?: boolean;
  /** Optional reference back into the flow graph. */
  node_id?: string;
  edge_id?: string;
}

export interface LensReport {
  lens: LensId;
  verdict: Verdict;
  reasoning: string;
  findings: CouncilFinding[];
  questions?: string[];
}

export interface ChairReport {
  overall_verdict: Verdict;
  recommendation: string;
  /** Top 1-3 things the user should resolve before approving. */
  top_concerns: string[];
  must_address_count: number;
}

/** Result block for a `flow_review` run. */
export interface FlowReviewResult {
  kind: "flow_review";
  lenses: LensReport[];
  chair: ChairReport;
}

/** Council-proposed task. Materialized into `tasks.json` with proposed:true. */
export interface ProposedTask {
  id: string;
  title: string;
  description?: string;
  priority?: number;
  /** Optional rationale linking back to flow nodes. */
  rationale?: string;
  /** Optional flow-node correlation. */
  source_node_ids?: string[];
}

/** Result block for a `task_planning` run. */
export interface TaskPlanningResult {
  kind: "task_planning";
  proposed_tasks: ProposedTask[];
  /** Cross-feature notes from the council, e.g. dependencies. */
  notes?: string;
  chair: ChairReport;
}

/**
 * Result block for an `architecture_review` run. Same shape as
 * flow_review (N lenses + chair) — the lens charters are
 * arch-focused (reliability, scalability, security, cost,
 * operability) but the artifact is interchangeable, so the
 * existing UI rendering + storage paths reuse without changes.
 */
export interface ArchReviewResult {
  kind: "architecture_review";
  lenses: LensReport[];
  chair: ChairReport;
}

export type CouncilResult = FlowReviewResult | TaskPlanningResult | ArchReviewResult;

export interface CouncilRun {
  id: string;
  project_slug: string;
  feature_id: string;
  type: CouncilRunType;
  status: CouncilRunStatus;
  started_at: number;
  finished_at?: number;
  /** Populated when status is `completed`. */
  result?: CouncilResult;
  /** Populated when status is `failed`. */
  error?: string;
  /** Snapshot of the agent's raw text output (for debug). */
  raw_text?: string;
}
