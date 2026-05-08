/**
 * Shared domain types used across applicators, storage, and routes.
 *
 * Mirrored on the client (`app/src/types.ts`). Keep in sync manually —
 * pulling in a workspace-shared types package isn't worth the build
 * complexity at this stage.
 */

export type FeatureStatus =
  | "draft"           // just created, no flow work yet
  | "flowing"         // user/agent actively drafting the flow
  | "flow_review"     // Phase 4: council reviewing the flow
  | "flow_approved"   // Phase 4: user explicitly approved
  | "planning"        // Phase 4: council generating tasks
  | "planned"         // Phase 4: tasks approved → feature unblocks queue
  | "in_progress"     // Phase 5: queue picked up tasks
  | "done"
  | "archived";

export const FEATURE_STATUSES: FeatureStatus[] = [
  "draft",
  "flowing",
  "flow_review",
  "flow_approved",
  "planning",
  "planned",
  "in_progress",
  "done",
  "archived",
];

/** Feature lifecycle states from which feature-attached tasks may exist. */
export const TASK_GATING_STATUSES: ReadonlySet<FeatureStatus> = new Set<FeatureStatus>([
  "planned",
  "in_progress",
  "done",
]);

export interface Feature {
  id: string;
  project_slug: string;
  name: string;
  description?: string;
  status: FeatureStatus;
  created_at: number;
  updated_at: number;
}

export interface FlowNode {
  id: string;
  feature_id: string;
  label: string;
  kind?: "step" | "decision" | "io" | "external";
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

export const TASK_STATUSES: TaskStatus[] = ["todo", "in_progress", "done", "stale"];

export interface Task {
  id: string;
  project_slug: string;
  feature_id?: string;        // null/undefined = ad-hoc
  title: string;
  description?: string;
  status: TaskStatus;
  priority?: number;          // higher = sooner; default 0
  proposed?: boolean;         // Phase 4: council-proposed, awaiting approval
  /**
   * Phase 9: resource_scope is a free-form string identifying a resource
   * (a service name, a file path, a DB migration ID, ...) that the task
   * needs exclusive access to. The parallel queue picker won't run two
   * tasks with overlapping scopes concurrently. Empty / undefined means
   * "no exclusivity required" — those tasks pack alongside anything.
   */
  resource_scope?: string;
  /**
   * Phase 10: when set, this task was spawned from a Tool. The queue
   * worker renders the tool's prompt template with `tool_args` instead of
   * using the generic task-execution prompt. Tasks without `tool_id` keep
   * the v1 behavior. `tool_args` keys must match the tool's declared
   * params — applicators validate this at submit time.
   */
  tool_id?: string;
  tool_args?: Record<string, string>;
  /**
   * Phase 11: stamped when a task was created by a cron tick. Useful for
   * filtering scheduled work and surfacing it differently in the UI.
   */
  cron_id?: string;
  created_at: number;
  updated_at: number;
}

// ---- Architecture (Phase 8) ----

export type ServiceKind =
  | "service"      // long-running app / API
  | "datastore"    // database, cache, object store
  | "queue"        // message broker
  | "external"     // third-party API or off-system component
  | "client"       // browser / mobile / desktop app
  | "infra";       // infrastructure: load balancer, DNS, etc.

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
  /** Optional hint about the edge (request, event, replication, etc.). */
  kind?: "request" | "event" | "data" | "dep";
}

export interface Architecture {
  services: ArchService[];
  edges: ArchEdge[];
  updated_at: number;
  /**
   * Timestamp the user last clicked "Approve architecture". Required to
   * pass the planning gate: `request_task_planning` is rejected when this
   * is unset. Any architecture mutation (add/update/remove service or
   * edge) clears it back to undefined, forcing a re-approval before more
   * tasks can be planned.
   */
  approved_at?: number;
}

// ---- Tools (Phase 10) ----

export type ToolParamType = "string" | "text" | "number" | "boolean" | "enum";

export interface ToolParam {
  /** Variable name used in the prompt template (`{{name}}`). */
  name: string;
  /** Human label shown in the run modal. */
  label?: string;
  type: ToolParamType;
  description?: string;
  required?: boolean;
  /** Default value (string-encoded — applicator coerces to type at run-time). */
  default?: string;
  /** Allowed values when type === "enum". */
  options?: string[];
}

/**
 * A reusable agent skill. Render `prompt_template` with the user-supplied
 * args and feed the result to `cursor-agent` against the chosen project's
 * workspace. Tools are global (live in `store/tools.json`) but always run
 * within a single project's scope — every run produces a Task that the
 * queue worker executes.
 *
 * The template is a tiny Mustache subset:
 *   - `{{var}}`            substitute the named variable
 *   - `{{var | "fallback"}}` literal-string fallback when var is empty
 *   - `{{#var}}…{{/var}}`  block, included only when var is truthy
 *
 * No nested sections, no inverted sections, no helpers — keeps the
 * surface area small and the prompts auditable.
 */
export interface Tool {
  id: string;
  /**
   * URL-safe stable identifier derived from `name` on create (no random
   * suffix — predictable so callers can address the tool at
   * `/v1/tools/<slug>/run`). Unique among active tools; on collision
   * the applicator appends `-2`, `-3`, … or the caller can override
   * explicitly. Editable via update_tool.
   */
  slug: string;
  name: string;
  /** One-line summary, shown on the tool card. */
  description?: string;
  /** Optional tag used to group tools in the UI (e.g. "tests", "deps"). */
  category?: string;
  prompt_template: string;
  params: ToolParam[];
  status: "active" | "archived";
  created_at: number;
  updated_at: number;
}

// ---- Council Personas (Phase 14) ----

/**
 * User-defined council lens. The "key" identifies the slot; default
 * keys (`product`, `ux`, `architecture`, `security`, `operability`)
 * are replaced when a persona declares the same key, and any other
 * key adds a new lens to the panel.
 *
 * Two scopes:
 *   - `global` — applies to every project's council.
 *   - `project` — applies only when reviewing features in that
 *     project. Overrides global on the same key.
 *
 * `key` doubles as the lens id stored on the resulting CouncilRun
 * artifacts (see `LensReport.lens`), so existing storage shape
 * stays put. Default-key replacements are transparent to the UI:
 * the artifact still records `lens: "ux"`, just with a different
 * persona's prompt behind it.
 *
 * `prompt_template` is the persona's *charter* — a short paragraph
 * that goes into the lens prompt's "Your charter:" line. We do NOT
 * Mustache-render this; it's pure prose so authors don't have to
 * think about escaping.
 */
export interface Persona {
  id: string;
  scope: "global" | "project";
  project_slug?: string;
  /** Lens slot id. Lowercase slug; matches a default key to replace. */
  key: string;
  /** Human-readable display name for the lens. */
  name: string;
  /** One-sentence summary; surfaces in the council UI's lens header. */
  description?: string;
  /**
   * Charter text injected into the lens prompt. The runner wraps it
   * with the standard council framing so authors only need to write
   * the lens-specific brief (e.g. "Marketing: review for go-to-
   * market clarity. Is the value prop crisp? …").
   */
  prompt_template: string;
  /**
   * Optional UI hint for the lens accent in the council canvas.
   * Recognized values map to palette colors; everything else falls
   * back to the default violet.
   */
  accent?: "cyan" | "violet" | "amber" | "green" | "rose";
  status: "active" | "archived";
  created_at: number;
  updated_at: number;
}

// ---- Tool Proposals (Phase 13) ----

/**
 * Agent-emitted suggestion that "this thing I just did would make a
 * good reusable Tool". Persisted as `pending` until the user accepts
 * (which materializes a real `Tool` and links them via `tool_id`) or
 * rejects (soft-delete; we keep rejected entries so future similar
 * proposals can be deduped or so the user can change their mind).
 *
 * Storage is global (`store/tool_proposals.json`) because the
 * resulting Tool is global. The proposal's `source` carries the
 * project / chat / task that triggered the idea so the user has
 * context when reviewing.
 *
 * The proposal payload is a *draft* of the same shape used by
 * `create_tool` — the agent fills in `name`, `description`,
 * `prompt_template`, and optionally `params`. The user can override
 * any of these at accept time, so the agent doesn't need to be
 * pixel-perfect.
 */
export interface ToolProposal {
  id: string;
  status: "pending" | "accepted" | "rejected";
  /** Draft tool fields — same shape as `create_tool` payload. */
  name: string;
  description?: string;
  category?: string;
  prompt_template: string;
  params?: ToolParam[];
  /** Free-form 1-2 sentence rationale from the agent ("why save this?"). */
  rationale?: string;
  /** Where the suggestion came from. */
  source: {
    kind: "chat" | "task" | "tool_run";
    /** Project the agent was working in, when applicable. */
    project_slug?: string;
    chat_id?: string;
    message_id?: string;
    task_id?: string;
  };
  /** Set when status flips to `accepted`. */
  tool_id?: string;
  created_at: number;
  updated_at: number;
}

// ---- Rules (Phase 12) ----

/**
 * Free-form guidance that gets appended to every `cursor-agent` system
 * prompt — chat, queue worker, council lenses, tool runs. Modeled after
 * Cursor's `AGENTS.md` / `.cursorrules`: short markdown bodies the user
 * authors once and the fleet picks up automatically.
 *
 * Two scopes:
 *   - **global** — `store/rules.json`. Applied to every invocation.
 *   - **project** — `store/<slug>/rules.json`. Applied only when the
 *     current scope is that project (chat, queue task, council run,
 *     tool run all carry an implicit project slug).
 *
 * `enabled: false` mutes a rule without deleting it (fast experiments).
 * `status: "archived"` is a soft delete — archived rules never inject
 * into prompts and are hidden from the default list.
 */
export interface Rule {
  id: string;
  /**
   * Where the rule lives. Mirrored on the wire so clients can render
   * scope independently of which file path they fetched from. For
   * project rules, `project_slug` is set.
   */
  scope: "global" | "project";
  project_slug?: string;
  title: string;
  /** Markdown body. Truncated to a budget when injected into prompts. */
  body: string;
  /** Optional grouping label, free-form ("style", "safety", …). */
  category?: string;
  /** When false, the rule still exists but is skipped at injection. */
  enabled: boolean;
  status: "active" | "archived";
  created_at: number;
  updated_at: number;
}

// ---- Cron (Phase 11) ----

/**
 * Tiny cron-style schedule. Standard 5-field crontab syntax:
 *   "<minute> <hour> <day-of-month> <month> <day-of-week>"
 * Each field accepts: `*`, single integer, comma list, or step (eg
 * `every-N`). Ranges (`1-5`) are also supported. No special strings
 * like "@hourly" — explicit fields keep the matcher trivial.
 */
export interface CronJob {
  id: string;
  /**
   * Stable filesystem-safe slug derived from `name` on create, deduped
   * against existing cron jobs. Currently used by the `standalone`
   * target to scope the cron's owned workspace + run history (lives at
   * `WORKSPACE_ROOT/_cron/<slug>/` and `store/_cron/<slug>/`). Older
   * cron jobs (created before this field landed) read back as
   * `undefined`; those rows are non-standalone targets where the slug
   * isn't needed.
   */
  slug?: string;
  name: string;
  description?: string;
  schedule: string;
  /** What the tick should do. */
  target:
    | { kind: "tool"; tool_id: string; project_slug: string; args?: Record<string, string>; priority?: number }
    | { kind: "queue"; project_slug?: string } // start the queue (optionally scoped)
    /**
     * Recurring raw task creation (no Tool wrapper). Each tick fires
     * `add_task` against the project. With `auto_start: true` the
     * scheduler also fires `start_task` so the queue worker picks it
     * up immediately; otherwise the task lands in the backlog as
     * `todo`. Use case: "every Monday 9am, drop a 'Triage PRs' card
     * into my backlog" or "every night at 2am, run the
     * dependency-bump task and exit on completion".
     */
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
     * Standalone cron — no project required. Each tick spawns
     * cursor-agent directly in the cron's owned workspace
     * (`WORKSPACE_ROOT/_cron/<slug>/`) and captures the run into
     * `store/_cron/<slug>/runs.jsonl` + `transcripts/<run_id>.jsonl`.
     * The prompt comes from either an inline `prompt` (auditable,
     * self-contained) or a referenced Tool (reusable across cron jobs).
     * Exactly one of the two must be set; applicator validates this.
     */
    | {
        kind: "standalone";
        /** Reference an existing Tool. Mutually exclusive with `prompt`. */
        tool_id?: string;
        /**
         * Inline prompt — used directly as the cursor-agent input.
         * Mutually exclusive with `tool_id`.
         */
        prompt?: string;
        /** Args supplied to the Tool's params (ignored when `prompt` is set). */
        args?: Record<string, string>;
      };
  enabled: boolean;
  /** Last successful tick (set when the target was dispatched). */
  last_run_at?: number;
  /** Last error (set if the most recent attempt failed). */
  last_error?: string;
  last_status?: "ok" | "error";
  created_at: number;
  updated_at: number;
}

// ---- Cron — standalone runs (Phase 23) ----

/**
 * One row per tick of a standalone cron job. Persisted to
 * `store/_cron/<slug>/runs.jsonl` (append-only, rotated to last 1000).
 * Pairs with `transcripts/<run_id>.jsonl` which holds the line-by-line
 * cursor-agent stdout for that run.
 */
export interface CronRun {
  run_id: string;
  cron_id: string;
  cron_slug: string;
  started_at: number;
  ended_at: number;
  status: "ok" | "error";
  duration_ms: number;
  /** Short error tail when status === "error". */
  error?: string;
  /** Bytes captured into the transcript (handy for the runs list UI). */
  transcript_bytes: number;
}
