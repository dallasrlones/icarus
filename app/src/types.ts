export type Role = "user" | "assistant" | "system";

export type PillPhase = "pending" | "applied" | "rejected";

export interface Pill {
  id: string;
  phase: PillPhase;
  kind?: string;
  result?: unknown;
  error?: string;
  body?: string;
}

export interface Message {
  id: string;
  role: Role;
  text: string;
  createdAt: number;
  pills?: Pill[];
}

export interface ChatSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

export interface Chat extends ChatSummary {
  messages: Message[];
}

export interface ProjectListing {
  slug: string;
  name: string;
  description?: string;
  workspace_path?: string;
  status: "active" | "archived";
  created_at: number;
  updated_at: number;
}

export interface ProjectDetail {
  project: ProjectListing;
  counts: { features: number; tasks: number; flows: number };
}

// ---- Domain types (mirrored from server/src/domain.ts) ----

export type FeatureStatus =
  | "draft"
  | "flowing"
  | "flow_review"
  | "flow_approved"
  | "planning"
  | "planned"
  | "in_progress"
  | "done"
  | "archived";

export interface Feature {
  id: string;
  project_slug: string;
  name: string;
  description?: string;
  status: FeatureStatus;
  created_at: number;
  updated_at: number;
}

export type FlowNodeKind = "step" | "decision" | "io" | "external";

export interface FlowNode {
  id: string;
  feature_id: string;
  label: string;
  kind?: FlowNodeKind;
  description?: string;
  x: number;
  y: number;
}

export interface FlowEdge {
  id: string;
  feature_id: string;
  from_node_id: string;
  to_node_id: string;
  label?: string;
}

export interface Flow {
  feature_id: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  updated_at: number;
}

export type TaskStatus = "todo" | "in_progress" | "done" | "stale";

export interface Task {
  id: string;
  project_slug: string;
  feature_id?: string;
  title: string;
  description?: string;
  status: TaskStatus;
  priority?: number;
  proposed?: boolean;
  resource_scope?: string;
  /** Phase 10: tool-backed task identifiers. */
  tool_id?: string;
  tool_args?: Record<string, string>;
  cron_id?: string;
  created_at: number;
  updated_at: number;
}

// ---- Architecture types (Phase 8) ----

export type ServiceKind =
  | "service"
  | "datastore"
  | "queue"
  | "external"
  | "client"
  | "infra";

export const SERVICE_KINDS: ServiceKind[] = [
  "service",
  "datastore",
  "queue",
  "external",
  "client",
  "infra",
];

export interface ArchService {
  id: string;
  name: string;
  kind: ServiceKind;
  description?: string;
  x: number;
  y: number;
}

export interface ArchEdge {
  id: string;
  from_service_id: string;
  to_service_id: string;
  label?: string;
  kind?: "request" | "event" | "data" | "dep";
}

export interface Architecture {
  services: ArchService[];
  edges: ArchEdge[];
  updated_at: number;
  /**
   * Unix-ms timestamp of the last user click on Approve. Required for
   * `request_task_planning`. Cleared automatically on any semantic edit
   * to the architecture.
   */
  approved_at?: number;
}

// ---- Council types (mirrored from server/src/council/types.ts) ----

export type CouncilRunType = "flow_review" | "task_planning";
export type CouncilRunStatus = "pending" | "running" | "completed" | "failed";
/**
 * Phase 14: lens id is now any persona key (default or custom). The
 * narrower `DefaultLensId` union is kept for the few places that
 * still want compile-time guarantees about defaults.
 */
export type LensId = string;
export type DefaultLensId = "product" | "ux" | "architecture" | "security" | "operability";
export const DEFAULT_LENS_IDS: DefaultLensId[] = [
  "product",
  "ux",
  "architecture",
  "security",
  "operability",
];
export type Severity = "info" | "minor" | "major" | "blocking";
export type Verdict = "approve" | "approve_with_notes" | "request_changes";

export interface CouncilFinding {
  severity: Severity;
  summary: string;
  must_address?: boolean;
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
  top_concerns: string[];
  must_address_count: number;
}

export interface FlowReviewResult {
  kind: "flow_review";
  lenses: LensReport[];
  chair: ChairReport;
}

export interface ProposedTask {
  id: string;
  title: string;
  description?: string;
  priority?: number;
  rationale?: string;
  source_node_ids?: string[];
}

export interface TaskPlanningResult {
  kind: "task_planning";
  proposed_tasks: ProposedTask[];
  notes?: string;
  chair: ChairReport;
}

export type CouncilResult = FlowReviewResult | TaskPlanningResult;

export interface CouncilRun {
  id: string;
  project_slug: string;
  feature_id: string;
  type: CouncilRunType;
  status: CouncilRunStatus;
  started_at: number;
  finished_at?: number;
  result?: CouncilResult;
  error?: string;
  raw_text?: string;
}

// ---- Queue / Question types (mirrored from server/src/queue/types.ts) ----

export type QueueRunState = "idle" | "running" | "paused";

export interface QueueScope {
  project_slug?: string;
}

export interface QueueState {
  run: QueueRunState;
  scope: QueueScope;
  changed_at: number;
  note?: string;
}

export type RunningTaskStatus =
  | "spawning"
  | "running"
  | "completed"
  | "failed"
  | "awaiting_question"
  | "cancelled";

export interface RunningTask {
  task_id: string;
  project_slug: string;
  title: string;
  started_at: number;
  finished_at?: number;
  status: RunningTaskStatus;
  output_tail: string;
  pills: number;
  retries: number;
  error?: string;
  blocking_question_id?: string;
}

export interface QueueSnapshot {
  state: QueueState;
  /** Convenience: first slot's running task, or null. Kept for backwards-compat with single-slot UI. */
  current: RunningTask | null;
  /** All currently-running tasks across all worker slots. */
  running: RunningTask[];
}

export type QuestionStatus = "open" | "answered" | "dismissed";

export interface Question {
  id: string;
  project_slug: string;
  task_id: string;
  body: string;
  options?: string[];
  asked_at: number;
  status: QuestionStatus;
  answer?: string;
  answer_choice?: number;
  answered_at?: number;
  dismissed_at?: number;
}

export type ChatScope = { kind: "global" } | { kind: "project"; slug: string };

export function scopeKey(scope: ChatScope): string {
  return scope.kind === "global" ? "global" : `project:${scope.slug}`;
}

export interface ActivityEntry {
  ts: number;
  kind: string;
  scope: { kind: "global" } | { kind: "project"; slug: string };
  payload: unknown;
  result?: unknown;
}

export type ProjectTab =
  | "chat"
  | "tasks"
  | "features"
  | "flows"
  | "architecture"
  | "code"
  | "questions"
  | "rules"
  | "personas"
  | "activity";

/** Phase 10/11/12/14/20: top-level tabs available on the global cockpit. */
export type GlobalTab = "chat" | "tools" | "cron" | "rules" | "personas" | "settings";

/** Phase 20 — per-role cursor-agent model selection. */
export interface ModelSettings {
  /** Used by chat handlers + voice spoken-summary. */
  chat: string;
  /** Used by queue worker, council runs, tool runs. */
  agent: string;
}

export type View =
  | { kind: "global"; tab: GlobalTab }
  | { kind: "project"; slug: string; tab: ProjectTab };

// ---- Tools (Phase 10) ----

export type ToolParamType = "string" | "text" | "number" | "boolean" | "enum";

export interface ToolParam {
  name: string;
  label?: string;
  type: ToolParamType;
  description?: string;
  required?: boolean;
  default?: string;
  options?: string[];
}

export interface Tool {
  id: string;
  /** URL-safe stable identifier; addressable at `/v1/tools/<slug>/run`. */
  slug: string;
  name: string;
  description?: string;
  category?: string;
  prompt_template: string;
  params: ToolParam[];
  status: "active" | "archived";
  created_at: number;
  updated_at: number;
}

// ---- Council Personas (Phase 14) ----

export interface Persona {
  id: string;
  scope: "global" | "project";
  project_slug?: string;
  key: string;
  name: string;
  description?: string;
  prompt_template: string;
  accent?: "cyan" | "violet" | "amber" | "green" | "rose";
  status: "active" | "archived";
  created_at: number;
  updated_at: number;
}

/**
 * Resolved lens slot — what the council will actually run for a given
 * scope. `source` traces where the persona came from so the UI can
 * show a "global override" / "project override" / "default" badge.
 */
export interface ResolvedPersona {
  key: string;
  name: string;
  description?: string;
  prompt_template: string;
  accent?: "cyan" | "violet" | "amber" | "green" | "rose";
  source: "default" | "global" | "project";
  /** Set when source ≠ "default". */
  persona_id?: string;
}

// ---- Tool Proposals (Phase 13) ----

export interface ToolProposal {
  id: string;
  status: "pending" | "accepted" | "rejected";
  name: string;
  description?: string;
  category?: string;
  prompt_template: string;
  params?: ToolParam[];
  rationale?: string;
  source: {
    kind: "chat" | "task" | "tool_run";
    project_slug?: string;
    chat_id?: string;
    message_id?: string;
    task_id?: string;
  };
  tool_id?: string;
  created_at: number;
  updated_at: number;
}

// ---- Cron (Phase 11) ----

export type CronTarget =
  | {
      kind: "tool";
      tool_id: string;
      project_slug: string;
      args?: Record<string, string>;
      priority?: number;
    }
  | { kind: "queue"; project_slug?: string }
  | {
      kind: "task";
      project_slug: string;
      title: string;
      description?: string;
      priority?: number;
      feature_id?: string;
      auto_start?: boolean;
    }
  /**
   * Phase 23: standalone cron — owns a private workspace at
   * `<WORKSPACE_ROOT>/_cron/<slug>/`. Either references a Tool or
   * carries an inline prompt (mutually exclusive). Run history +
   * transcripts persist to `store/_cron/<slug>/`.
   */
  | {
      kind: "standalone";
      tool_id?: string;
      prompt?: string;
      args?: Record<string, string>;
    };

export interface CronJob {
  id: string;
  /** Stable filesystem slug — set on create, used by standalone runs. */
  slug?: string;
  name: string;
  description?: string;
  schedule: string;
  target: CronTarget;
  enabled: boolean;
  last_run_at?: number;
  last_error?: string;
  last_status?: "ok" | "error";
  created_at: number;
  updated_at: number;
}

/**
 * Phase 23 — one row per standalone-cron tick. Persisted server-side
 * to `store/_cron/<slug>/runs.jsonl`. Mirrors `CronRun` in
 * server/src/domain.ts. Surfaced to the UI through `getCronRuns`.
 */
export interface CronRun {
  run_id: string;
  cron_id: string;
  cron_slug: string;
  started_at: number;
  ended_at: number;
  status: "ok" | "error";
  duration_ms: number;
  error?: string;
  transcript_bytes: number;
}

// ---- Rules (Phase 12) ----

export interface Rule {
  id: string;
  scope: "global" | "project";
  project_slug?: string;
  title: string;
  body: string;
  category?: string;
  enabled: boolean;
  status: "active" | "archived";
  created_at: number;
  updated_at: number;
}
