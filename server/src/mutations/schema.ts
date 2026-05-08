import { z } from "zod";

/**
 * Mutation envelope schema.
 *
 * Every state-changing call goes through `POST /v1/mutations/apply` with
 * one of these `kind` values. Payloads are kind-specific zod schemas; the
 * apply endpoint dispatches based on kind.
 *
 * Naming style mirrors the source repo's `*_patch` / verb conventions.
 */

// ---- Project verbs ----

export const CreateProjectPayload = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  /**
   * One of three modes:
   *  - omitted / null  → planning-only project, no workspace yet
   *  - existing path   → use that folder as the project workspace
   *  - "auto"          → server creates `<WORKSPACE_DIR>/<slug>` and git-inits it
   */
  workspace_path: z.union([z.string(), z.literal("auto"), z.null()]).optional(),
});
export type CreateProjectPayload = z.infer<typeof CreateProjectPayload>;

export const ArchiveProjectPayload = z.object({
  slug: z.string().min(1),
});
export type ArchiveProjectPayload = z.infer<typeof ArchiveProjectPayload>;

// ---- Feature verbs ----

export const AddFeaturePayload = z.object({
  project_slug: z.string().min(1),
  name: z.string().min(1).max(120),
  description: z.string().max(4000).optional(),
});
export type AddFeaturePayload = z.infer<typeof AddFeaturePayload>;

export const UpdateFeaturePayload = z.object({
  project_slug: z.string().min(1),
  feature_id: z.string().min(1),
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(4000).optional(),
});
export type UpdateFeaturePayload = z.infer<typeof UpdateFeaturePayload>;

export const ArchiveFeaturePayload = z.object({
  project_slug: z.string().min(1),
  feature_id: z.string().min(1),
});
export type ArchiveFeaturePayload = z.infer<typeof ArchiveFeaturePayload>;

// ---- Flow verbs ----

const FlowNodeKind = z.enum(["step", "decision", "io", "external"]);

export const AddFlowNodePayload = z.object({
  project_slug: z.string().min(1),
  feature_id: z.string().min(1),
  label: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  kind: FlowNodeKind.optional(),
  x: z.number().optional(),
  y: z.number().optional(),
});
export type AddFlowNodePayload = z.infer<typeof AddFlowNodePayload>;

export const UpdateFlowNodePayload = z.object({
  project_slug: z.string().min(1),
  feature_id: z.string().min(1),
  node_id: z.string().min(1),
  label: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).optional(),
  kind: FlowNodeKind.optional(),
  x: z.number().optional(),
  y: z.number().optional(),
});
export type UpdateFlowNodePayload = z.infer<typeof UpdateFlowNodePayload>;

export const RemoveFlowNodePayload = z.object({
  project_slug: z.string().min(1),
  feature_id: z.string().min(1),
  node_id: z.string().min(1),
});
export type RemoveFlowNodePayload = z.infer<typeof RemoveFlowNodePayload>;

/**
 * AddFlowEdge endpoints accept either `*_node_id` (preferred) or
 * `*_node_label` (resolved server-side against the feature's flow). The
 * label form is the escape hatch for chat agents drafting a fresh flow:
 * they emit `add_flow_node` for each step and `add_flow_edge` referencing
 * those nodes by label in the same turn — applicators run in order under
 * the project lock, so by the time the edge applies, the labels resolve.
 *
 * If a label matches multiple nodes, the most recently-created one wins
 * (matches the agent's intent of "the node I just made").
 */
export const AddFlowEdgePayload = z
  .object({
    project_slug: z.string().min(1),
    feature_id: z.string().min(1),
    from_node_id: z.string().min(1).optional(),
    to_node_id: z.string().min(1).optional(),
    from_node_label: z.string().min(1).optional(),
    to_node_label: z.string().min(1).optional(),
    label: z.string().max(120).optional(),
  })
  .refine((p) => p.from_node_id || p.from_node_label, {
    message: "from_node_id or from_node_label is required",
  })
  .refine((p) => p.to_node_id || p.to_node_label, {
    message: "to_node_id or to_node_label is required",
  });
export type AddFlowEdgePayload = z.infer<typeof AddFlowEdgePayload>;

export const RemoveFlowEdgePayload = z.object({
  project_slug: z.string().min(1),
  feature_id: z.string().min(1),
  edge_id: z.string().min(1),
});
export type RemoveFlowEdgePayload = z.infer<typeof RemoveFlowEdgePayload>;

export const UpdateFlowEdgePayload = z.object({
  project_slug: z.string().min(1),
  feature_id: z.string().min(1),
  edge_id: z.string().min(1),
  // Pass an empty string to clear the label.
  label: z.string().max(120).optional(),
});
export type UpdateFlowEdgePayload = z.infer<typeof UpdateFlowEdgePayload>;

// ---- Task verbs ----

export const AddTaskPayload = z.object({
  project_slug: z.string().min(1),
  feature_id: z.string().min(1).optional(),
  title: z.string().min(1).max(200),
  description: z.string().max(4000).optional(),
  priority: z.number().int().optional(),
  resource_scope: z.string().max(120).optional(),
  // Phase 10: tool-backed task. The applicator validates that tool_id
  // exists and tool_args satisfy the tool's declared params.
  tool_id: z.string().min(1).optional(),
  tool_args: z.record(z.string(), z.string()).optional(),
});
export type AddTaskPayload = z.infer<typeof AddTaskPayload>;

export const UpdateTaskPayload = z.object({
  project_slug: z.string().min(1),
  task_id: z.string().min(1),
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(4000).optional(),
  priority: z.number().int().optional(),
  status: z.enum(["todo", "in_progress", "done", "stale"]).optional(),
  resource_scope: z.string().max(120).optional(),
});
export type UpdateTaskPayload = z.infer<typeof UpdateTaskPayload>;

export const ArchiveTaskPayload = z.object({
  project_slug: z.string().min(1),
  task_id: z.string().min(1),
});
export type ArchiveTaskPayload = z.infer<typeof ArchiveTaskPayload>;

// ---- Council verbs ----

export const RequestFlowReviewPayload = z.object({
  project_slug: z.string().min(1),
  feature_id: z.string().min(1),
});
export type RequestFlowReviewPayload = z.infer<typeof RequestFlowReviewPayload>;

export const ApproveFlowPayload = z.object({
  project_slug: z.string().min(1),
  feature_id: z.string().min(1),
  /** Optional run_id the user is approving against; defaults to latest. */
  run_id: z.string().optional(),
});
export type ApproveFlowPayload = z.infer<typeof ApproveFlowPayload>;

export const RequestFlowChangesPayload = z.object({
  project_slug: z.string().min(1),
  feature_id: z.string().min(1),
  notes: z.string().max(4000).optional(),
});
export type RequestFlowChangesPayload = z.infer<typeof RequestFlowChangesPayload>;

export const RequestTaskPlanningPayload = z.object({
  project_slug: z.string().min(1),
  feature_id: z.string().min(1),
});
export type RequestTaskPlanningPayload = z.infer<typeof RequestTaskPlanningPayload>;

export const ApproveTasksPayload = z.object({
  project_slug: z.string().min(1),
  feature_id: z.string().min(1),
  /** Subset of proposed task ids to keep; un-listed proposals get dropped. */
  task_ids: z.array(z.string().min(1)).min(1),
});
export type ApproveTasksPayload = z.infer<typeof ApproveTasksPayload>;

// ---- Queue verbs (UI / chat) ----

export const StartQueuePayload = z.object({
  /** When set, restrict the picker to a single project. */
  project_slug: z.string().min(1).optional(),
});
export type StartQueuePayload = z.infer<typeof StartQueuePayload>;

export const PauseQueuePayload = z.object({
  note: z.string().max(500).optional(),
});
export type PauseQueuePayload = z.infer<typeof PauseQueuePayload>;

export const StopQueuePayload = PauseQueuePayload;
export type StopQueuePayload = z.infer<typeof StopQueuePayload>;

export const StartTaskPayload = z.object({
  project_slug: z.string().min(1),
  task_id: z.string().min(1),
});
export type StartTaskPayload = z.infer<typeof StartTaskPayload>;

// ---- Worker-emitted verbs ----

const ArtifactRef = z.object({
  path: z.string().min(1),
  kind: z.enum(["file", "diff", "link"]).optional(),
  note: z.string().max(280).optional(),
});

export const CompleteTaskPayload = z.object({
  project_slug: z.string().min(1),
  task_id: z.string().min(1),
  summary: z.string().min(1).max(2000),
  artifacts: z.array(ArtifactRef).optional(),
});
export type CompleteTaskPayload = z.infer<typeof CompleteTaskPayload>;

export const FailTaskPayload = z.object({
  project_slug: z.string().min(1),
  task_id: z.string().min(1),
  reason: z.string().min(1).max(2000),
});
export type FailTaskPayload = z.infer<typeof FailTaskPayload>;

export const EnqueueQuestionPayload = z.object({
  project_slug: z.string().min(1),
  task_id: z.string().min(1),
  body: z.string().min(1).max(4000),
  options: z.array(z.string().min(1).max(280)).max(8).optional(),
});
export type EnqueueQuestionPayload = z.infer<typeof EnqueueQuestionPayload>;

export const AnswerQuestionPayload = z.object({
  project_slug: z.string().min(1),
  question_id: z.string().min(1),
  answer: z.string().min(1).max(4000),
  /** Index into the question's `options` array, when applicable. */
  choice: z.number().int().min(0).max(7).optional(),
});
export type AnswerQuestionPayload = z.infer<typeof AnswerQuestionPayload>;

export const DismissQuestionPayload = z.object({
  project_slug: z.string().min(1),
  question_id: z.string().min(1),
});
export type DismissQuestionPayload = z.infer<typeof DismissQuestionPayload>;

// ---- Architecture (Phase 8) ----

const ServiceKindSchema = z.enum([
  "service",
  "datastore",
  "queue",
  "external",
  "client",
  "infra",
]);

export const AddServicePayload = z.object({
  project_slug: z.string().min(1),
  name: z.string().min(1).max(120),
  kind: ServiceKindSchema.optional(),
  description: z.string().max(2000).optional(),
  x: z.number().optional(),
  y: z.number().optional(),
});
export type AddServicePayload = z.infer<typeof AddServicePayload>;

export const UpdateServicePayload = z.object({
  project_slug: z.string().min(1),
  service_id: z.string().min(1),
  name: z.string().min(1).max(120).optional(),
  kind: ServiceKindSchema.optional(),
  description: z.string().max(2000).optional(),
  x: z.number().optional(),
  y: z.number().optional(),
});
export type UpdateServicePayload = z.infer<typeof UpdateServicePayload>;

export const RemoveServicePayload = z.object({
  project_slug: z.string().min(1),
  service_id: z.string().min(1),
});
export type RemoveServicePayload = z.infer<typeof RemoveServicePayload>;

/**
 * Same id-or-name pattern as AddFlowEdgePayload — agents can reference
 * services by name when they're drafting an architecture in one turn.
 */
export const AddArchEdgePayload = z
  .object({
    project_slug: z.string().min(1),
    from_service_id: z.string().min(1).optional(),
    to_service_id: z.string().min(1).optional(),
    from_service_name: z.string().min(1).optional(),
    to_service_name: z.string().min(1).optional(),
    label: z.string().max(120).optional(),
    kind: z.enum(["request", "event", "data", "dep"]).optional(),
  })
  .refine((p) => p.from_service_id || p.from_service_name, {
    message: "from_service_id or from_service_name is required",
  })
  .refine((p) => p.to_service_id || p.to_service_name, {
    message: "to_service_id or to_service_name is required",
  });
export type AddArchEdgePayload = z.infer<typeof AddArchEdgePayload>;

export const RemoveArchEdgePayload = z.object({
  project_slug: z.string().min(1),
  edge_id: z.string().min(1),
});

/**
 * Architecture approval gates `request_task_planning`. Approving sets a
 * timestamp; any subsequent semantic edit (services or edges) clears it
 * automatically, so the user has to re-approve before more tasks plan.
 */
export const ApproveArchitecturePayload = z.object({
  project_slug: z.string().min(1),
});
export type ApproveArchitecturePayload = z.infer<typeof ApproveArchitecturePayload>;

export const UnapproveArchitecturePayload = z.object({
  project_slug: z.string().min(1),
});
export type UnapproveArchitecturePayload = z.infer<typeof UnapproveArchitecturePayload>;

/**
 * Phase 18 — kick off an architecture-review council run. The
 * council's chair verdict drives `approve_architecture`
 * automatically (auto-decide is the whole point of the verb;
 * the user clicks `unapprove_architecture` after the fact if
 * they disagree).
 */
export const RequestArchReviewPayload = z.object({
  project_slug: z.string().min(1),
});
export type RequestArchReviewPayload = z.infer<typeof RequestArchReviewPayload>;

/**
 * Phase 19 — voice user toggle. Global setting, no scope.
 * `enabled: false` flips `settings.voice.disabled` on so the
 * health probe short-circuits and POST endpoints return 503
 * without trying the upstreams. Use it when off-LAN to avoid
 * eating the 4s probe timeout per poll.
 */
export const SetVoiceEnabledPayload = z.object({
  enabled: z.boolean(),
});
export type SetVoiceEnabledPayload = z.infer<typeof SetVoiceEnabledPayload>;

/**
 * Phase 20 — per-role cursor-agent model selection. Either field
 * can be omitted (leave that role untouched) or passed as `""`
 * which is interpreted as "reset to default" by the settings
 * patcher. Both fields are otherwise free-text model slugs (e.g.
 * `composer-2`, `claude-opus-4.7`, `gpt-5.5-medium`) — we don't
 * lock the schema to a specific list because cursor-agent's model
 * catalog evolves outside this repo.
 */
export const SetModelsPayload = z.object({
  chat: z.string().optional(),
  agent: z.string().optional(),
});
export type SetModelsPayload = z.infer<typeof SetModelsPayload>;

/**
 * Phase 21 — agent-facing voice endpoint hot-swap. Lets the agent
 * point icarus at a different STT/TTS provider on user request
 * ("use openai whisper for stt", "switch tts back to my orin").
 *
 * Deliberately does NOT include auth tokens — those stay UI-only
 * (see `PATCH /v1/settings/voice`). The mutation envelope is
 * inspectable in chat history and the activity log; surfacing
 * Bearer tokens through it would be a leak risk.
 *
 * Empty string clears the field (env-var fallback wins). Omitted
 * field leaves the current value alone.
 */
export const SetVoiceEndpointsPayload = z.object({
  stt_url: z.string().optional(),
  tts_url: z.string().optional(),
  voice: z.string().optional(),
  language: z.string().optional(),
});
export type SetVoiceEndpointsPayload = z.infer<typeof SetVoiceEndpointsPayload>;

/**
 * After a project is created we can edit its descriptive metadata —
 * notably the workspace_path, which is the only way to bring a
 * planning-only project online for the code browser without recreating
 * it. Pass `workspace_path: null` to revert a project to planning-only;
 * pass `workspace_path: "auto"` to have the server create
 * `<WORKSPACE_DIR>/<slug>` and git-init it (matching create_project).
 */
export const UpdateProjectPayload = z.object({
  slug: z.string().min(1),
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).optional(),
  workspace_path: z.union([z.string(), z.literal("auto"), z.null()]).optional(),
});
export type UpdateProjectPayload = z.infer<typeof UpdateProjectPayload>;
export type RemoveArchEdgePayload = z.infer<typeof RemoveArchEdgePayload>;

// ---- Tools (Phase 10) ----

const ToolParamPayload = z.object({
  name: z.string().min(1).max(64).regex(/^[A-Za-z_][A-Za-z0-9_]*$/, {
    message: "param name must be a valid identifier (a-z, A-Z, 0-9, _; not starting with a digit)",
  }),
  label: z.string().max(120).optional(),
  type: z.enum(["string", "text", "number", "boolean", "enum"]),
  description: z.string().max(500).optional(),
  required: z.boolean().optional(),
  default: z.string().max(2000).optional(),
  options: z.array(z.string().max(120)).optional(),
});

/**
 * Tool slug pattern: lowercase a-z 0-9 and `-`, no leading/trailing
 * hyphens, max 64 chars. Matches what `nameToSlug` produces and keeps
 * URLs predictable without escaping.
 */
const ToolSlug = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message:
      "slug must be lowercase letters/digits/hyphens, no leading/trailing hyphens",
  });

export const CreateToolPayload = z.object({
  name: z.string().min(1).max(120),
  /** Optional: override the auto-derived slug. */
  slug: ToolSlug.optional(),
  description: z.string().max(2000).optional(),
  category: z.string().max(60).optional(),
  prompt_template: z.string().min(1).max(20_000),
  params: z.array(ToolParamPayload).max(32).optional(),
});
export type CreateToolPayload = z.infer<typeof CreateToolPayload>;

export const UpdateToolPayload = z.object({
  tool_id: z.string().min(1),
  name: z.string().min(1).max(120).optional(),
  slug: ToolSlug.optional(),
  description: z.string().max(2000).optional(),
  category: z.string().max(60).optional(),
  prompt_template: z.string().min(1).max(20_000).optional(),
  params: z.array(ToolParamPayload).max(32).optional(),
});
export type UpdateToolPayload = z.infer<typeof UpdateToolPayload>;

export const ArchiveToolPayload = z.object({
  tool_id: z.string().min(1),
});
export type ArchiveToolPayload = z.infer<typeof ArchiveToolPayload>;

// ---- Tool Proposals (Phase 13) ----

const ToolProposalSource = z.object({
  kind: z.enum(["chat", "task", "tool_run"]),
  project_slug: z.string().min(1).optional(),
  chat_id: z.string().min(1).optional(),
  message_id: z.string().min(1).optional(),
  task_id: z.string().min(1).optional(),
});

/**
 * Agent emits this mid-turn when it notices the work it just did
 * could be parametrized into a reusable Tool. Same field shape as
 * `create_tool` minus the `slug` (slug is decided at accept time).
 * The `source` block carries provenance so the user has context when
 * reviewing the suggestion.
 *
 * Conservative-by-default: the agent's system-prompt guidance asks
 * it to emit only when there's a clear repeatable pattern; one-off
 * exploration is not a tool.
 */
export const ProposeToolPayload = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  category: z.string().max(60).optional(),
  prompt_template: z.string().min(1).max(20_000),
  params: z.array(ToolParamPayload).max(32).optional(),
  rationale: z.string().max(500).optional(),
  source: ToolProposalSource,
});
export type ProposeToolPayload = z.infer<typeof ProposeToolPayload>;

/**
 * Materialize a pending proposal into a real Tool. `overrides`
 * lets the user tweak any field at accept time (rename, edit
 * template, add/remove params, choose a custom slug). Server
 * builds a `CreateToolPayload` from `proposal + overrides` and
 * runs the same `applyCreateTool` path the chat / UI would.
 */
export const AcceptToolProposalPayload = z.object({
  proposal_id: z.string().min(1),
  overrides: z
    .object({
      name: z.string().min(1).max(120).optional(),
      slug: ToolSlug.optional(),
      description: z.string().max(2000).optional(),
      category: z.string().max(60).optional(),
      prompt_template: z.string().min(1).max(20_000).optional(),
      params: z.array(ToolParamPayload).max(32).optional(),
    })
    .optional(),
});
export type AcceptToolProposalPayload = z.infer<typeof AcceptToolProposalPayload>;

export const RejectToolProposalPayload = z.object({
  proposal_id: z.string().min(1),
});
export type RejectToolProposalPayload = z.infer<typeof RejectToolProposalPayload>;

/**
 * Run a tool against a project. Creates a Task carrying `tool_id` +
 * `tool_args`, then either enqueues it (`auto_start: false`, default) or
 * spawns it immediately on the queue worker (`auto_start: true`). Args
 * are coerced and validated against the tool's declared params.
 */
export const RunToolPayload = z.object({
  tool_id: z.string().min(1),
  project_slug: z.string().min(1),
  args: z.record(z.string(), z.string()).optional(),
  title: z.string().min(1).max(200).optional(),
  priority: z.number().int().optional(),
  auto_start: z.boolean().optional(),
});
export type RunToolPayload = z.infer<typeof RunToolPayload>;

// ---- Cron (Phase 11) ----

const CronTargetPayload = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("tool"),
      tool_id: z.string().min(1).optional(),
      // Same id-or-name escape hatch as add_arch_edge: agents can emit
      // `create_tool` + `create_cron` in one turn by referencing the
      // brand-new tool by its name. Resolved server-side.
      tool_name: z.string().min(1).optional(),
      project_slug: z.string().min(1),
      args: z.record(z.string(), z.string()).optional(),
      priority: z.number().int().optional(),
    })
    .refine((p) => p.tool_id || p.tool_name, {
      message: "tool_id or tool_name is required",
    }),
  z.object({
    kind: z.literal("queue"),
    project_slug: z.string().min(1).optional(),
  }),
  // Recurring raw task: each tick fires `add_task` (and optionally
  // `start_task` when `auto_start: true`). Same shape as AddTaskPayload
  // sans the auto_start sugar — duplicated so the cron-target schema
  // stays self-contained and validates at parse time.
  z.object({
    kind: z.literal("task"),
    project_slug: z.string().min(1),
    title: z.string().min(1).max(200),
    description: z.string().max(4_000).optional(),
    priority: z.number().int().optional(),
    feature_id: z.string().min(1).optional(),
    auto_start: z.boolean().optional(),
  }),
]);

export const CreateCronPayload = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  schedule: z.string().min(1).max(120),
  target: CronTargetPayload,
  enabled: z.boolean().optional(),
});
export type CreateCronPayload = z.infer<typeof CreateCronPayload>;

export const UpdateCronPayload = z.object({
  cron_id: z.string().min(1),
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).optional(),
  schedule: z.string().min(1).max(120).optional(),
  target: CronTargetPayload.optional(),
  enabled: z.boolean().optional(),
});
export type UpdateCronPayload = z.infer<typeof UpdateCronPayload>;

export const ArchiveCronPayload = z.object({
  cron_id: z.string().min(1),
});
export type ArchiveCronPayload = z.infer<typeof ArchiveCronPayload>;

export const SetCronEnabledPayload = z.object({
  cron_id: z.string().min(1),
  enabled: z.boolean(),
});
export type SetCronEnabledPayload = z.infer<typeof SetCronEnabledPayload>;

/** Fire a cron job's target right now, ignoring the schedule. */
export const RunCronNowPayload = z.object({
  cron_id: z.string().min(1),
});
export type RunCronNowPayload = z.infer<typeof RunCronNowPayload>;

// ---- Rules (Phase 12) ----

/**
 * Where the rule lives. Most mutations carry the scope explicitly so
 * the applicator knows which file to touch without scanning every
 * project. `update_rule` / `archive_rule` / `set_rule_enabled` accept
 * an optional `scope` for fast-path lookups, but fall back to
 * `findRuleById` if absent.
 */
const RuleScope = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("global") }),
  z.object({ kind: z.literal("project"), project_slug: z.string().min(1) }),
]);

export const CreateRulePayload = z.object({
  scope: RuleScope,
  title: z.string().min(1).max(160),
  body: z.string().min(1).max(8_000),
  category: z.string().max(60).optional(),
  enabled: z.boolean().optional(),
});
export type CreateRulePayload = z.infer<typeof CreateRulePayload>;

export const UpdateRulePayload = z.object({
  rule_id: z.string().min(1),
  /** Optional fast-path; applicator falls back to id-scan if absent. */
  scope: RuleScope.optional(),
  title: z.string().min(1).max(160).optional(),
  body: z.string().min(1).max(8_000).optional(),
  category: z.string().max(60).optional(),
  enabled: z.boolean().optional(),
});
export type UpdateRulePayload = z.infer<typeof UpdateRulePayload>;

export const ArchiveRulePayload = z.object({
  rule_id: z.string().min(1),
  scope: RuleScope.optional(),
});
export type ArchiveRulePayload = z.infer<typeof ArchiveRulePayload>;

export const SetRuleEnabledPayload = z.object({
  rule_id: z.string().min(1),
  enabled: z.boolean(),
  scope: RuleScope.optional(),
});
export type SetRuleEnabledPayload = z.infer<typeof SetRuleEnabledPayload>;

// ---- Personas (Phase 14) ----

/**
 * Lens-slot key. Lowercase letters, digits, and hyphens only — same
 * shape as a tool slug. Matches a default key (`product`, `ux`,
 * `architecture`, `security`, `operability`) to replace; any other
 * value adds a new lens slot.
 */
const PersonaKey = z
  .string()
  .min(1)
  .max(60)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message:
      "persona key must be lowercase letters/digits/hyphens, no leading/trailing hyphens",
  });

const PersonaAccent = z.enum(["cyan", "violet", "amber", "green", "rose"]);

// PersonaScope reuses the same shape as RuleScope but stays its own
// constant so we can evolve the two independently (e.g. if personas
// later support team-scope). One source of truth would conflate them.
const PersonaScope = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("global") }),
  z.object({ kind: z.literal("project"), project_slug: z.string().min(1) }),
]);

export const CreatePersonaPayload = z.object({
  scope: PersonaScope,
  key: PersonaKey,
  name: z.string().min(1).max(80),
  description: z.string().max(280).optional(),
  prompt_template: z.string().min(1).max(8_000),
  accent: PersonaAccent.optional(),
});
export type CreatePersonaPayload = z.infer<typeof CreatePersonaPayload>;

export const UpdatePersonaPayload = z.object({
  persona_id: z.string().min(1),
  scope: PersonaScope.optional(),
  key: PersonaKey.optional(),
  name: z.string().min(1).max(80).optional(),
  description: z.string().max(280).optional(),
  prompt_template: z.string().min(1).max(8_000).optional(),
  accent: PersonaAccent.optional(),
});
export type UpdatePersonaPayload = z.infer<typeof UpdatePersonaPayload>;

export const ArchivePersonaPayload = z.object({
  persona_id: z.string().min(1),
  scope: PersonaScope.optional(),
});
export type ArchivePersonaPayload = z.infer<typeof ArchivePersonaPayload>;

// ---- Navigation (Phase 15) ----
//
// `navigate` is unusual: it doesn't mutate any disk state. The agent
// emits it (in response to a voice command like "open the tasks tab"
// or a chat ask like "go to feature foo") and the server forwards
// the request as a targeted WS event to the originating client.
//
// We piggyback on the mutation envelope so this verb shares the same
// schema-retry loop, system-prompt vocabulary, and audit log as
// every other agent-emitted verb. The applicator doesn't write to
// disk — it just validates and broadcasts.

const ProjectTab = z.enum([
  "chat",
  "tasks",
  "features",
  "flows",
  "architecture",
  "code",
  "questions",
  "rules",
  "personas",
  "activity",
]);
const GlobalTab = z.enum(["chat", "tools", "cron", "rules", "personas", "settings"]);

/**
 * Navigate targets. Each kind accepts either an exact id (preferred when
 * the agent has it) OR a name (resolved server-side, most-recently-created
 * match wins).
 *
 * Why both forms — Phase 21:
 *   The id form is fragile when the agent is creating + navigating in the
 *   same turn: `add_feature` / `add_task` results aren't echoed back
 *   into the agent's stream until the *next* turn (via `pendingMemory`),
 *   so the agent can't reference what it just created. Letting the agent
 *   re-send the same name it used in the create payload closes that gap.
 *
 *   This mirrors the existing `add_flow_edge` pattern (`*_node_id` OR
 *   `*_node_label`) so the agent has one consistent escape hatch.
 *
 * Resolution rules (see `applyNavigate`):
 *   - exactly one of the id-form / name-form must be set
 *   - name match is case-insensitive on the entity's `name` (project) or
 *     `name`/`title` (feature/task), most recently `created_at` wins on tie
 *   - unresolvable names produce a 404 the same way unknown ids do
 */
const NavigateTarget = z.discriminatedUnion("kind", [
  // "Open the global cockpit; optionally switch to a tab there."
  z.object({ kind: z.literal("global"), tab: GlobalTab.optional() }),
  // "Open project <slug or name>; optionally switch to a specific tab."
  z
    .object({
      kind: z.literal("project"),
      project_slug: z.string().min(1).optional(),
      project_name: z.string().min(1).optional(),
      tab: ProjectTab.optional(),
    })
    .refine((v) => !!v.project_slug || !!v.project_name, {
      message: "navigate.target(project): one of project_slug | project_name is required",
    }),
  // "Open project <slug or name>'s Features tab and pre-select <feature>."
  z
    .object({
      kind: z.literal("feature"),
      project_slug: z.string().min(1).optional(),
      project_name: z.string().min(1).optional(),
      feature_id: z.string().min(1).optional(),
      feature_name: z.string().min(1).optional(),
    })
    .refine(
      (v) => (!!v.project_slug || !!v.project_name) && (!!v.feature_id || !!v.feature_name),
      { message: "navigate.target(feature): need project_slug|project_name and feature_id|feature_name" },
    ),
  // "Open project <slug or name>'s Tasks tab and pre-select <task>."
  z
    .object({
      kind: z.literal("task"),
      project_slug: z.string().min(1).optional(),
      project_name: z.string().min(1).optional(),
      task_id: z.string().min(1).optional(),
      task_name: z.string().min(1).optional(),
    })
    .refine(
      (v) => (!!v.project_slug || !!v.project_name) && (!!v.task_id || !!v.task_name),
      { message: "navigate.target(task): need project_slug|project_name and task_id|task_name" },
    ),
]);

export const NavigatePayload = z.object({
  target: NavigateTarget,
  /**
   * Optional one-line rationale ("matched 'icarus' → project icarus-d8bf").
   * Shown in the activity log so the user can audit voice routing.
   */
  reason: z.string().max(280).optional(),
});
export type NavigatePayload = z.infer<typeof NavigatePayload>;

// ---- Envelope ----

const Envelope = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("create_project"), payload: CreateProjectPayload, client_id: z.string().optional() }),
  z.object({ kind: z.literal("update_project"), payload: UpdateProjectPayload, client_id: z.string().optional() }),
  z.object({ kind: z.literal("archive_project"), payload: ArchiveProjectPayload, client_id: z.string().optional() }),

  z.object({ kind: z.literal("add_feature"), payload: AddFeaturePayload, client_id: z.string().optional() }),
  z.object({ kind: z.literal("update_feature"), payload: UpdateFeaturePayload, client_id: z.string().optional() }),
  z.object({ kind: z.literal("archive_feature"), payload: ArchiveFeaturePayload, client_id: z.string().optional() }),

  z.object({ kind: z.literal("add_flow_node"), payload: AddFlowNodePayload, client_id: z.string().optional() }),
  z.object({ kind: z.literal("update_flow_node"), payload: UpdateFlowNodePayload, client_id: z.string().optional() }),
  z.object({ kind: z.literal("remove_flow_node"), payload: RemoveFlowNodePayload, client_id: z.string().optional() }),
  z.object({ kind: z.literal("add_flow_edge"), payload: AddFlowEdgePayload, client_id: z.string().optional() }),
  z.object({ kind: z.literal("update_flow_edge"), payload: UpdateFlowEdgePayload, client_id: z.string().optional() }),
  z.object({ kind: z.literal("remove_flow_edge"), payload: RemoveFlowEdgePayload, client_id: z.string().optional() }),

  z.object({ kind: z.literal("add_task"), payload: AddTaskPayload, client_id: z.string().optional() }),
  z.object({ kind: z.literal("update_task"), payload: UpdateTaskPayload, client_id: z.string().optional() }),
  z.object({ kind: z.literal("archive_task"), payload: ArchiveTaskPayload, client_id: z.string().optional() }),

  z.object({ kind: z.literal("request_flow_review"), payload: RequestFlowReviewPayload, client_id: z.string().optional() }),
  z.object({ kind: z.literal("approve_flow"), payload: ApproveFlowPayload, client_id: z.string().optional() }),
  z.object({ kind: z.literal("request_flow_changes"), payload: RequestFlowChangesPayload, client_id: z.string().optional() }),
  z.object({ kind: z.literal("request_task_planning"), payload: RequestTaskPlanningPayload, client_id: z.string().optional() }),
  z.object({ kind: z.literal("approve_tasks"), payload: ApproveTasksPayload, client_id: z.string().optional() }),

  z.object({ kind: z.literal("start_queue"), payload: StartQueuePayload, client_id: z.string().optional() }),
  z.object({ kind: z.literal("pause_queue"), payload: PauseQueuePayload, client_id: z.string().optional() }),
  z.object({ kind: z.literal("stop_queue"), payload: StopQueuePayload, client_id: z.string().optional() }),
  z.object({ kind: z.literal("start_task"), payload: StartTaskPayload, client_id: z.string().optional() }),

  z.object({ kind: z.literal("complete_task"), payload: CompleteTaskPayload, client_id: z.string().optional() }),
  z.object({ kind: z.literal("fail_task"), payload: FailTaskPayload, client_id: z.string().optional() }),
  z.object({ kind: z.literal("enqueue_question"), payload: EnqueueQuestionPayload, client_id: z.string().optional() }),
  z.object({ kind: z.literal("answer_question"), payload: AnswerQuestionPayload, client_id: z.string().optional() }),
  z.object({ kind: z.literal("dismiss_question"), payload: DismissQuestionPayload, client_id: z.string().optional() }),

  z.object({ kind: z.literal("add_service"), payload: AddServicePayload, client_id: z.string().optional() }),
  z.object({ kind: z.literal("update_service"), payload: UpdateServicePayload, client_id: z.string().optional() }),
  z.object({ kind: z.literal("remove_service"), payload: RemoveServicePayload, client_id: z.string().optional() }),
  z.object({ kind: z.literal("add_arch_edge"), payload: AddArchEdgePayload, client_id: z.string().optional() }),
  z.object({ kind: z.literal("remove_arch_edge"), payload: RemoveArchEdgePayload, client_id: z.string().optional() }),
  z.object({ kind: z.literal("approve_architecture"), payload: ApproveArchitecturePayload, client_id: z.string().optional() }),
  z.object({ kind: z.literal("unapprove_architecture"), payload: UnapproveArchitecturePayload, client_id: z.string().optional() }),
  z.object({ kind: z.literal("request_arch_review"), payload: RequestArchReviewPayload, client_id: z.string().optional() }),

  z.object({ kind: z.literal("set_voice_enabled"), payload: SetVoiceEnabledPayload, client_id: z.string().optional() }),
  z.object({ kind: z.literal("set_models"), payload: SetModelsPayload, client_id: z.string().optional() }),
  z.object({ kind: z.literal("set_voice_endpoints"), payload: SetVoiceEndpointsPayload, client_id: z.string().optional() }),

  z.object({ kind: z.literal("create_tool"), payload: CreateToolPayload, client_id: z.string().optional() }),
  z.object({ kind: z.literal("update_tool"), payload: UpdateToolPayload, client_id: z.string().optional() }),
  z.object({ kind: z.literal("archive_tool"), payload: ArchiveToolPayload, client_id: z.string().optional() }),
  z.object({ kind: z.literal("run_tool"), payload: RunToolPayload, client_id: z.string().optional() }),

  z.object({ kind: z.literal("propose_tool"), payload: ProposeToolPayload, client_id: z.string().optional() }),
  z.object({ kind: z.literal("accept_tool_proposal"), payload: AcceptToolProposalPayload, client_id: z.string().optional() }),
  z.object({ kind: z.literal("reject_tool_proposal"), payload: RejectToolProposalPayload, client_id: z.string().optional() }),

  z.object({ kind: z.literal("create_cron"), payload: CreateCronPayload, client_id: z.string().optional() }),
  z.object({ kind: z.literal("update_cron"), payload: UpdateCronPayload, client_id: z.string().optional() }),
  z.object({ kind: z.literal("archive_cron"), payload: ArchiveCronPayload, client_id: z.string().optional() }),
  z.object({ kind: z.literal("set_cron_enabled"), payload: SetCronEnabledPayload, client_id: z.string().optional() }),
  z.object({ kind: z.literal("run_cron_now"), payload: RunCronNowPayload, client_id: z.string().optional() }),

  z.object({ kind: z.literal("create_rule"), payload: CreateRulePayload, client_id: z.string().optional() }),
  z.object({ kind: z.literal("update_rule"), payload: UpdateRulePayload, client_id: z.string().optional() }),
  z.object({ kind: z.literal("archive_rule"), payload: ArchiveRulePayload, client_id: z.string().optional() }),
  z.object({ kind: z.literal("set_rule_enabled"), payload: SetRuleEnabledPayload, client_id: z.string().optional() }),

  z.object({ kind: z.literal("create_persona"), payload: CreatePersonaPayload, client_id: z.string().optional() }),
  z.object({ kind: z.literal("update_persona"), payload: UpdatePersonaPayload, client_id: z.string().optional() }),
  z.object({ kind: z.literal("archive_persona"), payload: ArchivePersonaPayload, client_id: z.string().optional() }),

  z.object({ kind: z.literal("navigate"), payload: NavigatePayload, client_id: z.string().optional() }),
]);
export type MutationEnvelope = z.infer<typeof Envelope>;

export function parseEnvelope(input: unknown):
  | { ok: true; envelope: MutationEnvelope }
  | { ok: false; error: string } {
  const parsed = Envelope.safeParse(input);
  if (parsed.success) return { ok: true, envelope: parsed.data };
  return { ok: false, error: formatZodError(parsed.error) };
}

function formatZodError(err: z.ZodError): string {
  return err.issues
    .map((iss) => `${iss.path.join(".") || "(root)"}: ${iss.message}`)
    .join("; ");
}
