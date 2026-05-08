import path from "node:path";
import fs from "node:fs/promises";
import { dedupeSlug, nameToSlug, shortId, slugify } from "../ids.js";
import { ensureDir, writeJson } from "../storage/json.js";
import {
  cronTranscriptsDir,
  cronWorkspaceDir,
  projectDir,
  projectFile,
} from "../storage/paths.js";
import { readFleet, writeFleet, type ProjectListing } from "../storage/fleet.js";
import { globalLocks, projectLocks } from "../storage/locks.js";
import {
  ensureFlow,
  readArchitecture,
  readFeatures,
  readFlows,
  readTasks,
  writeArchitecture,
  writeFeatures,
  writeFlows,
  writeTasks,
} from "../storage/entities.js";
import { readTools, writeTools } from "../storage/tools.js";
import { readCronJobs, writeCronJobs } from "../storage/cron.js";
import {
  findRuleById,
  readGlobalRules,
  readProjectRules,
  writeGlobalRules,
  writeProjectRules,
} from "../storage/rules.js";
import {
  patchModelSettings,
  patchVoiceEndpoints,
  patchVoiceSettings,
} from "../storage/settings.js";
import {
  readToolProposals,
  writeToolProposals,
} from "../storage/tool_proposals.js";
import {
  findPersonaById,
  readGlobalPersonas,
  readProjectPersonas,
  writeGlobalPersonas,
  writeProjectPersonas,
} from "../storage/personas.js";
import { coerceArgs } from "../tools/render.js";
import { parse as parseCron } from "../cron/expr.js";
import {
  TASK_GATING_STATUSES,
  type CronJob,
  type Feature,
  type FlowEdge,
  type FlowNode,
  type Persona,
  type Rule,
  type Task,
  type Tool,
  type ToolProposal,
} from "../domain.js";
import { latestRun, saveRun } from "../council/storage.js";
import { getCouncilRunner } from "../council/runner.js";
import { events } from "../events.js";
import type { CouncilRun } from "../council/types.js";
import { PROJECT_SCOPED_FEATURE_ID } from "../council/types.js";
import { getQueueWorker } from "../queue/worker.js";
import { readQuestions, writeQuestions } from "../queue/storage.js";
import type { Question } from "../queue/types.js";
import type {
  AddArchEdgePayload,
  AddFeaturePayload,
  AddFlowEdgePayload,
  AddFlowNodePayload,
  AddServicePayload,
  AddTaskPayload,
  AnswerQuestionPayload,
  ApproveArchitecturePayload,
  ApproveFlowPayload,
  ApproveTasksPayload,
  ArchiveCronPayload,
  ArchiveFeaturePayload,
  ArchiveProjectPayload,
  ArchiveTaskPayload,
  ArchiveToolPayload,
  CompleteTaskPayload,
  CreateCronPayload,
  CreateProjectPayload,
  CreateToolPayload,
  DismissQuestionPayload,
  EnqueueQuestionPayload,
  FailTaskPayload,
  MutationEnvelope,
  PauseQueuePayload,
  RemoveArchEdgePayload,
  RemoveFlowEdgePayload,
  RemoveFlowNodePayload,
  RemoveServicePayload,
  RequestArchReviewPayload,
  RequestFlowChangesPayload,
  RequestFlowReviewPayload,
  RequestTaskPlanningPayload,
  SetVoiceEnabledPayload,
  SetVoiceEndpointsPayload,
  SetModelsPayload,
  AcceptToolProposalPayload,
  ArchivePersonaPayload,
  ArchiveRulePayload,
  CreatePersonaPayload,
  CreateRulePayload,
  NavigatePayload,
  ProposeToolPayload,
  RejectToolProposalPayload,
  RunCronNowPayload,
  RunToolPayload,
  SetCronEnabledPayload,
  SetRuleEnabledPayload,
  UpdatePersonaPayload,
  UpdateRulePayload,
  StartQueuePayload,
  StartTaskPayload,
  StopQueuePayload,
  UnapproveArchitecturePayload,
  UpdateCronPayload,
  UpdateFeaturePayload,
  UpdateFlowEdgePayload,
  UpdateFlowNodePayload,
  UpdateProjectPayload,
  UpdateServicePayload,
  UpdateTaskPayload,
  UpdateToolPayload,
} from "./schema.js";

/**
 * Per-kind applicators. Each takes a typed payload and returns the result
 * to be returned to the caller (and broadcast to event subscribers).
 *
 * Mutations that touch a single project must run inside that project's
 * lock so concurrent writes can't interleave.
 */

export interface ApplyContext {
  /** Where to put auto-created project workspaces (host-side absolute path). */
  workspaceRoot: string;
}

export interface ApplyResult {
  scope: { kind: "global" } | { kind: "project"; slug: string };
  result: unknown;
}

export async function apply(envelope: MutationEnvelope, ctx: ApplyContext): Promise<ApplyResult> {
  switch (envelope.kind) {
    case "create_project":   return await applyCreateProject(envelope.payload, ctx);
    case "update_project":   return await applyUpdateProject(envelope.payload, ctx);
    case "archive_project":  return await applyArchiveProject(envelope.payload);

    case "add_feature":      return await applyAddFeature(envelope.payload);
    case "update_feature":   return await applyUpdateFeature(envelope.payload);
    case "archive_feature":  return await applyArchiveFeature(envelope.payload);

    case "add_flow_node":    return await applyAddFlowNode(envelope.payload);
    case "update_flow_node": return await applyUpdateFlowNode(envelope.payload);
    case "remove_flow_node": return await applyRemoveFlowNode(envelope.payload);
    case "add_flow_edge":    return await applyAddFlowEdge(envelope.payload);
    case "update_flow_edge": return await applyUpdateFlowEdge(envelope.payload);
    case "remove_flow_edge": return await applyRemoveFlowEdge(envelope.payload);

    case "add_task":         return await applyAddTask(envelope.payload);
    case "update_task":      return await applyUpdateTask(envelope.payload);
    case "archive_task":     return await applyArchiveTask(envelope.payload);

    case "request_flow_review":   return await applyRequestFlowReview(envelope.payload);
    case "approve_flow":          return await applyApproveFlow(envelope.payload);
    case "request_flow_changes":  return await applyRequestFlowChanges(envelope.payload);
    case "request_task_planning": return await applyRequestTaskPlanning(envelope.payload);
    case "approve_tasks":         return await applyApproveTasks(envelope.payload);

    case "start_queue":           return await applyStartQueue(envelope.payload);
    case "pause_queue":           return await applyPauseQueue(envelope.payload);
    case "stop_queue":            return await applyStopQueue(envelope.payload);
    case "start_task":            return await applyStartTask(envelope.payload);

    case "complete_task":         return await applyCompleteTask(envelope.payload);
    case "fail_task":             return await applyFailTask(envelope.payload);
    case "enqueue_question":      return await applyEnqueueQuestion(envelope.payload);
    case "answer_question":       return await applyAnswerQuestion(envelope.payload);
    case "dismiss_question":      return await applyDismissQuestion(envelope.payload);

    case "add_service":           return await applyAddService(envelope.payload);
    case "update_service":        return await applyUpdateService(envelope.payload);
    case "remove_service":        return await applyRemoveService(envelope.payload);
    case "add_arch_edge":         return await applyAddArchEdge(envelope.payload);
    case "remove_arch_edge":      return await applyRemoveArchEdge(envelope.payload);
    case "approve_architecture":   return await applyApproveArchitecture(envelope.payload);
    case "unapprove_architecture": return await applyUnapproveArchitecture(envelope.payload);
    case "request_arch_review":    return await applyRequestArchReview(envelope.payload);

    case "set_voice_enabled":      return await applySetVoiceEnabled(envelope.payload);
    case "set_voice_endpoints":    return await applySetVoiceEndpoints(envelope.payload);
    case "set_models":             return await applySetModels(envelope.payload);

    case "create_tool":           return await applyCreateTool(envelope.payload);
    case "update_tool":           return await applyUpdateTool(envelope.payload);
    case "archive_tool":          return await applyArchiveTool(envelope.payload);
    case "run_tool":              return await applyRunTool(envelope.payload);

    case "propose_tool":          return await applyProposeTool(envelope.payload);
    case "accept_tool_proposal":  return await applyAcceptToolProposal(envelope.payload);
    case "reject_tool_proposal":  return await applyRejectToolProposal(envelope.payload);

    case "create_cron":           return await applyCreateCron(envelope.payload, ctx);
    case "update_cron":           return await applyUpdateCron(envelope.payload, ctx);
    case "archive_cron":          return await applyArchiveCron(envelope.payload);
    case "set_cron_enabled":      return await applySetCronEnabled(envelope.payload);
    case "run_cron_now":          return await applyRunCronNow(envelope.payload);

    case "create_persona":        return await applyCreatePersona(envelope.payload);
    case "update_persona":        return await applyUpdatePersona(envelope.payload);
    case "archive_persona":       return await applyArchivePersona(envelope.payload);

    case "navigate":              return await applyNavigate(envelope.payload, envelope.client_id);

    case "create_rule":           return await applyCreateRule(envelope.payload);
    case "update_rule":           return await applyUpdateRule(envelope.payload);
    case "archive_rule":          return await applyArchiveRule(envelope.payload);
    case "set_rule_enabled":      return await applySetRuleEnabled(envelope.payload);
  }
}

// ---- Project applicators ----

async function applyCreateProject(
  payload: CreateProjectPayload,
  ctx: ApplyContext,
): Promise<ApplyResult> {
  const slug = slugify(payload.name);

  let workspacePath: string | undefined;
  if (payload.workspace_path === "auto") {
    workspacePath = path.join(ctx.workspaceRoot, slug);
    await ensureDir(workspacePath);
  } else if (typeof payload.workspace_path === "string" && payload.workspace_path.length > 0) {
    workspacePath = payload.workspace_path;
  }

  const now = Date.now();
  const listing: ProjectListing = {
    slug,
    name: payload.name,
    description: payload.description,
    workspace_path: workspacePath,
    status: "active",
    created_at: now,
    updated_at: now,
  };

  return await projectLocks.run(slug, async () => {
    await ensureDir(projectDir(slug));

    await writeJson(projectFile(slug, "project.json"), {
      slug,
      name: payload.name,
      description: payload.description ?? "",
      workspace_path: workspacePath ?? null,
      status: "active",
      created_at: now,
      updated_at: now,
    });
    await writeJson(projectFile(slug, "features.json"), { features: [] });
    await writeJson(projectFile(slug, "tasks.json"), { tasks: [] });
    await writeJson(projectFile(slug, "flows.json"), { flows: [] });
    await writeJson(projectFile(slug, "architecture.json"), {
      services: [],
      edges: [],
      updated_at: now,
    });
    await writeJson(projectFile(slug, "questions.json"), { questions: [] });

    const fleet = await readFleet();
    fleet.projects = [listing, ...fleet.projects.filter((p) => p.slug !== slug)];
    await writeFleet(fleet);

    return { scope: { kind: "project", slug }, result: { project: listing } };
  });
}

async function applyArchiveProject(payload: ArchiveProjectPayload): Promise<ApplyResult> {
  return await projectLocks.run(payload.slug, async () => {
    const fleet = await readFleet();
    const i = fleet.projects.findIndex((p) => p.slug === payload.slug);
    if (i < 0) throw new ApplicatorError(`unknown project slug: ${payload.slug}`, 404);
    fleet.projects[i] = { ...fleet.projects[i], status: "archived", updated_at: Date.now() };
    await writeFleet(fleet);

    try {
      const meta = await fs.readFile(projectFile(payload.slug, "project.json"), "utf8");
      const obj = JSON.parse(meta);
      obj.status = "archived";
      obj.updated_at = Date.now();
      await writeJson(projectFile(payload.slug, "project.json"), obj);
    } catch {
      // project.json missing is non-fatal — the fleet entry is the source of truth.
    }

    return { scope: { kind: "project", slug: payload.slug }, result: { slug: payload.slug } };
  });
}

/**
 * Patch the descriptive metadata on an existing project. Only the fields
 * provided in the payload are touched. The most important use case is
 * promoting a planning-only project to a real workspace (the Code tab's
 * inline setup form rides on this), but we also let users rename or
 * tweak descriptions without going through chat.
 */
async function applyUpdateProject(
  payload: UpdateProjectPayload,
  ctx: ApplyContext,
): Promise<ApplyResult> {
  return await projectLocks.run(payload.slug, async () => {
    const fleet = await readFleet();
    const i = fleet.projects.findIndex((p) => p.slug === payload.slug);
    if (i < 0) throw new ApplicatorError(`unknown project slug: ${payload.slug}`, 404);
    const prev = fleet.projects[i];

    let workspacePath: string | undefined | null = undefined;
    if (payload.workspace_path !== undefined) {
      if (payload.workspace_path === null) {
        workspacePath = null;
      } else if (payload.workspace_path === "auto") {
        const auto = path.join(ctx.workspaceRoot, payload.slug);
        await ensureDir(auto);
        workspacePath = auto;
      } else if (payload.workspace_path.length > 0) {
        workspacePath = payload.workspace_path;
      } else {
        // Empty string: treat as "clear it" (planning-only).
        workspacePath = null;
      }
    }

    const now = Date.now();
    const next: ProjectListing = {
      ...prev,
      name: payload.name ?? prev.name,
      description: payload.description ?? prev.description,
      workspace_path:
        workspacePath === null
          ? undefined
          : workspacePath === undefined
            ? prev.workspace_path
            : workspacePath,
      updated_at: now,
    };
    fleet.projects[i] = next;
    await writeFleet(fleet);

    // Mirror to the per-project project.json so reads stay consistent.
    try {
      const meta = await fs.readFile(projectFile(payload.slug, "project.json"), "utf8");
      const obj = JSON.parse(meta);
      if (payload.name !== undefined) obj.name = payload.name;
      if (payload.description !== undefined) obj.description = payload.description;
      if (workspacePath !== undefined) {
        obj.workspace_path = workspacePath; // null | string
      }
      obj.updated_at = now;
      await writeJson(projectFile(payload.slug, "project.json"), obj);
    } catch {
      // Non-fatal — the fleet entry is the source of truth.
    }

    return { scope: { kind: "project", slug: payload.slug }, result: { project: next } };
  });
}

// ---- Feature applicators ----

async function applyAddFeature(payload: AddFeaturePayload): Promise<ApplyResult> {
  return await projectLocks.run(payload.project_slug, async () => {
    await assertProject(payload.project_slug);
    const features = await readFeatures(payload.project_slug);
    const now = Date.now();
    const feature: Feature = {
      id: shortId("ft"),
      project_slug: payload.project_slug,
      name: payload.name,
      description: payload.description,
      status: "draft",
      created_at: now,
      updated_at: now,
    };
    features.unshift(feature);
    await writeFeatures(payload.project_slug, features);
    return {
      scope: { kind: "project", slug: payload.project_slug },
      result: { feature },
    };
  });
}

async function applyUpdateFeature(payload: UpdateFeaturePayload): Promise<ApplyResult> {
  return await projectLocks.run(payload.project_slug, async () => {
    const features = await readFeatures(payload.project_slug);
    const i = features.findIndex((f) => f.id === payload.feature_id);
    if (i < 0) throw new ApplicatorError(`unknown feature: ${payload.feature_id}`, 404);
    const updated: Feature = {
      ...features[i],
      ...(payload.name !== undefined ? { name: payload.name } : {}),
      ...(payload.description !== undefined ? { description: payload.description } : {}),
      updated_at: Date.now(),
    };
    features[i] = updated;
    await writeFeatures(payload.project_slug, features);
    return {
      scope: { kind: "project", slug: payload.project_slug },
      result: { feature: updated },
    };
  });
}

async function applyArchiveFeature(payload: ArchiveFeaturePayload): Promise<ApplyResult> {
  return await projectLocks.run(payload.project_slug, async () => {
    const features = await readFeatures(payload.project_slug);
    const i = features.findIndex((f) => f.id === payload.feature_id);
    if (i < 0) throw new ApplicatorError(`unknown feature: ${payload.feature_id}`, 404);
    features[i] = { ...features[i], status: "archived", updated_at: Date.now() };
    await writeFeatures(payload.project_slug, features);
    return {
      scope: { kind: "project", slug: payload.project_slug },
      result: { feature: features[i] },
    };
  });
}

// ---- Flow applicators ----
//
// All flow mutations share an opinionated side effect: when a node or edge
// is added to a feature in `draft`, the feature transitions to `flowing`.
// That keeps the lifecycle truthful without the user having to bump the
// status by hand.

async function applyAddFlowNode(payload: AddFlowNodePayload): Promise<ApplyResult> {
  return await projectLocks.run(payload.project_slug, async () => {
    const features = await readFeatures(payload.project_slug);
    const feat = features.find((f) => f.id === payload.feature_id);
    if (!feat) throw new ApplicatorError(`unknown feature: ${payload.feature_id}`, 404);

    const flows = await readFlows(payload.project_slug);
    const flow = ensureFlow(flows, payload.feature_id);
    const node: FlowNode = {
      id: shortId("node"),
      feature_id: payload.feature_id,
      label: payload.label,
      description: payload.description,
      kind: payload.kind,
      x: payload.x ?? defaultNodeX(flow.nodes.length),
      y: payload.y ?? defaultNodeY(flow.nodes.length),
    };
    flow.nodes.push(node);
    flow.updated_at = Date.now();

    bumpFeatureToFlowing(features, feat);
    const stale = await applyStaleOnEdit(payload.project_slug, features, feat);

    await writeFlows(payload.project_slug, flows);
    await writeFeatures(payload.project_slug, features);

    return {
      scope: { kind: "project", slug: payload.project_slug },
      result: { node, feature: feat, ...stale },
    };
  });
}

async function applyUpdateFlowNode(payload: UpdateFlowNodePayload): Promise<ApplyResult> {
  return await projectLocks.run(payload.project_slug, async () => {
    const flows = await readFlows(payload.project_slug);
    const flow = flows.find((f) => f.feature_id === payload.feature_id);
    if (!flow) throw new ApplicatorError(`feature has no flow yet: ${payload.feature_id}`, 404);
    const i = flow.nodes.findIndex((n) => n.id === payload.node_id);
    if (i < 0) throw new ApplicatorError(`unknown node: ${payload.node_id}`, 404);

    // Pure position changes (drag) shouldn't invalidate council approval —
    // only label/kind/description edits are semantic.
    const isSemanticEdit =
      payload.label !== undefined ||
      payload.kind !== undefined ||
      payload.description !== undefined;

    flow.nodes[i] = {
      ...flow.nodes[i],
      ...(payload.label !== undefined ? { label: payload.label } : {}),
      ...(payload.description !== undefined ? { description: payload.description } : {}),
      ...(payload.kind !== undefined ? { kind: payload.kind } : {}),
      ...(payload.x !== undefined ? { x: payload.x } : {}),
      ...(payload.y !== undefined ? { y: payload.y } : {}),
    };
    flow.updated_at = Date.now();
    await writeFlows(payload.project_slug, flows);

    let stale: { stale_tasks?: number } = {};
    if (isSemanticEdit) {
      const features = await readFeatures(payload.project_slug);
      const feat = features.find((f) => f.id === payload.feature_id);
      if (feat) {
        stale = await applyStaleOnEdit(payload.project_slug, features, feat);
        await writeFeatures(payload.project_slug, features);
      }
    }

    return {
      scope: { kind: "project", slug: payload.project_slug },
      result: { node: flow.nodes[i], ...stale },
    };
  });
}

async function applyRemoveFlowNode(payload: RemoveFlowNodePayload): Promise<ApplyResult> {
  return await projectLocks.run(payload.project_slug, async () => {
    const flows = await readFlows(payload.project_slug);
    const flow = flows.find((f) => f.feature_id === payload.feature_id);
    if (!flow) throw new ApplicatorError(`feature has no flow yet: ${payload.feature_id}`, 404);
    const before = flow.nodes.length;
    flow.nodes = flow.nodes.filter((n) => n.id !== payload.node_id);
    if (flow.nodes.length === before) {
      throw new ApplicatorError(`unknown node: ${payload.node_id}`, 404);
    }
    // Cascade: drop any edges that referenced the removed node.
    const edgesBefore = flow.edges.length;
    flow.edges = flow.edges.filter(
      (e) => e.from_node_id !== payload.node_id && e.to_node_id !== payload.node_id,
    );
    flow.updated_at = Date.now();
    await writeFlows(payload.project_slug, flows);

    const features = await readFeatures(payload.project_slug);
    const feat = features.find((f) => f.id === payload.feature_id);
    let stale: { stale_tasks?: number } = {};
    if (feat) {
      stale = await applyStaleOnEdit(payload.project_slug, features, feat);
      await writeFeatures(payload.project_slug, features);
    }

    return {
      scope: { kind: "project", slug: payload.project_slug },
      result: {
        removed_node_id: payload.node_id,
        cascaded_edges: edgesBefore - flow.edges.length,
        ...stale,
      },
    };
  });
}

async function applyAddFlowEdge(payload: AddFlowEdgePayload): Promise<ApplyResult> {
  return await projectLocks.run(payload.project_slug, async () => {
    const features = await readFeatures(payload.project_slug);
    const feat = features.find((f) => f.id === payload.feature_id);
    if (!feat) throw new ApplicatorError(`unknown feature: ${payload.feature_id}`, 404);

    const flows = await readFlows(payload.project_slug);
    const flow = ensureFlow(flows, payload.feature_id);

    // Resolve from/to either as ids (preferred) or labels (chat fallback).
    const fromId = resolveNodeRef(flow, payload.from_node_id, payload.from_node_label, "from");
    const toId = resolveNodeRef(flow, payload.to_node_id, payload.to_node_label, "to");
    if (fromId === toId) {
      throw new ApplicatorError("edge endpoints must differ", 400);
    }
    const edge: FlowEdge = {
      id: shortId("edge"),
      feature_id: payload.feature_id,
      from_node_id: fromId,
      to_node_id: toId,
      label: payload.label,
    };
    flow.edges.push(edge);
    flow.updated_at = Date.now();

    bumpFeatureToFlowing(features, feat);
    const stale = await applyStaleOnEdit(payload.project_slug, features, feat);

    await writeFlows(payload.project_slug, flows);
    await writeFeatures(payload.project_slug, features);

    return {
      scope: { kind: "project", slug: payload.project_slug },
      result: { edge, ...stale },
    };
  });
}

async function applyUpdateFlowEdge(payload: UpdateFlowEdgePayload): Promise<ApplyResult> {
  return await projectLocks.run(payload.project_slug, async () => {
    const flows = await readFlows(payload.project_slug);
    const flow = flows.find((f) => f.feature_id === payload.feature_id);
    if (!flow) throw new ApplicatorError(`feature has no flow yet: ${payload.feature_id}`, 404);
    const edge = flow.edges.find((e) => e.id === payload.edge_id);
    if (!edge) throw new ApplicatorError(`unknown edge: ${payload.edge_id}`, 404);

    // Empty string clears the label; undefined leaves it as-is.
    const beforeLabel = edge.label;
    if (typeof payload.label !== "undefined") {
      const trimmed = payload.label.trim();
      edge.label = trimmed.length === 0 ? undefined : trimmed;
    }
    if (edge.label === beforeLabel) {
      // No-op — the agent or user re-emitted the same value. Treat as success
      // but skip the stale-on-edit bump so click-ops doesn't churn lifecycle.
      return {
        scope: { kind: "project", slug: payload.project_slug },
        result: { edge },
      };
    }
    flow.updated_at = Date.now();
    await writeFlows(payload.project_slug, flows);

    const features = await readFeatures(payload.project_slug);
    const feat = features.find((f) => f.id === payload.feature_id);
    let stale: { stale_tasks?: number } = {};
    if (feat) {
      bumpFeatureToFlowing(features, feat);
      stale = await applyStaleOnEdit(payload.project_slug, features, feat);
      await writeFeatures(payload.project_slug, features);
    }

    return {
      scope: { kind: "project", slug: payload.project_slug },
      result: { edge, ...stale },
    };
  });
}

async function applyRemoveFlowEdge(payload: RemoveFlowEdgePayload): Promise<ApplyResult> {
  return await projectLocks.run(payload.project_slug, async () => {
    const flows = await readFlows(payload.project_slug);
    const flow = flows.find((f) => f.feature_id === payload.feature_id);
    if (!flow) throw new ApplicatorError(`feature has no flow yet: ${payload.feature_id}`, 404);
    const before = flow.edges.length;
    flow.edges = flow.edges.filter((e) => e.id !== payload.edge_id);
    if (flow.edges.length === before) {
      throw new ApplicatorError(`unknown edge: ${payload.edge_id}`, 404);
    }
    flow.updated_at = Date.now();
    await writeFlows(payload.project_slug, flows);

    const features = await readFeatures(payload.project_slug);
    const feat = features.find((f) => f.id === payload.feature_id);
    let stale: { stale_tasks?: number } = {};
    if (feat) {
      stale = await applyStaleOnEdit(payload.project_slug, features, feat);
      await writeFeatures(payload.project_slug, features);
    }

    return {
      scope: { kind: "project", slug: payload.project_slug },
      result: { removed_edge_id: payload.edge_id, ...stale },
    };
  });
}

// ---- Task applicators ----

async function applyAddTask(payload: AddTaskPayload): Promise<ApplyResult> {
  return await projectLocks.run(payload.project_slug, async () => {
    if (payload.feature_id) {
      const features = await readFeatures(payload.project_slug);
      const feat = features.find((f) => f.id === payload.feature_id);
      if (!feat) throw new ApplicatorError(`unknown feature: ${payload.feature_id}`, 404);
      if (!TASK_GATING_STATUSES.has(feat.status)) {
        throw new ApplicatorError(
          `feature ${payload.feature_id} is in status \`${feat.status}\`. ` +
            "Feature-attached tasks require the feature to be `planned` or later " +
            "(approve the flow + plan tasks first). For ad-hoc tasks, omit `feature_id`.",
          409,
        );
      }
    }

    // If a tool_id is supplied, validate against the tool registry and
    // coerce args. We resolve the lookup outside the project lock — the
    // tools registry has its own lock and we only read here.
    let coercedArgs: Record<string, string> | undefined;
    if (payload.tool_id) {
      const tools = await readTools();
      const tool = tools.find((t) => t.id === payload.tool_id && t.status === "active");
      if (!tool) {
        throw new ApplicatorError(`unknown or archived tool: ${payload.tool_id}`, 404);
      }
      try {
        coercedArgs = coerceArgs(tool.params, payload.tool_args ?? {});
      } catch (err) {
        throw new ApplicatorError(
          err instanceof Error ? err.message : String(err),
          400,
        );
      }
    } else if (payload.tool_args) {
      throw new ApplicatorError("tool_args supplied without tool_id", 400);
    }

    const tasks = await readTasks(payload.project_slug);
    const now = Date.now();
    const task: Task = {
      id: shortId("task"),
      project_slug: payload.project_slug,
      feature_id: payload.feature_id,
      title: payload.title,
      description: payload.description,
      status: "todo",
      priority: payload.priority,
      resource_scope: payload.resource_scope,
      tool_id: payload.tool_id,
      tool_args: coercedArgs,
      created_at: now,
      updated_at: now,
    };
    tasks.unshift(task);
    await writeTasks(payload.project_slug, tasks);
    return {
      scope: { kind: "project", slug: payload.project_slug },
      result: { task },
    };
  });
}

async function applyUpdateTask(payload: UpdateTaskPayload): Promise<ApplyResult> {
  return await projectLocks.run(payload.project_slug, async () => {
    const tasks = await readTasks(payload.project_slug);
    const i = tasks.findIndex((t) => t.id === payload.task_id);
    if (i < 0) throw new ApplicatorError(`unknown task: ${payload.task_id}`, 404);
    tasks[i] = {
      ...tasks[i],
      ...(payload.title !== undefined ? { title: payload.title } : {}),
      ...(payload.description !== undefined ? { description: payload.description } : {}),
      ...(payload.priority !== undefined ? { priority: payload.priority } : {}),
      ...(payload.status !== undefined ? { status: payload.status } : {}),
      ...(payload.resource_scope !== undefined ? { resource_scope: payload.resource_scope } : {}),
      updated_at: Date.now(),
    };
    await writeTasks(payload.project_slug, tasks);
    return {
      scope: { kind: "project", slug: payload.project_slug },
      result: { task: tasks[i] },
    };
  });
}

async function applyArchiveTask(payload: ArchiveTaskPayload): Promise<ApplyResult> {
  return await projectLocks.run(payload.project_slug, async () => {
    const tasks = await readTasks(payload.project_slug);
    const before = tasks.length;
    const next = tasks.filter((t) => t.id !== payload.task_id);
    if (next.length === before) throw new ApplicatorError(`unknown task: ${payload.task_id}`, 404);
    await writeTasks(payload.project_slug, next);
    return {
      scope: { kind: "project", slug: payload.project_slug },
      result: { archived_task_id: payload.task_id },
    };
  });
}

// ---- Council applicators ----

async function applyRequestFlowReview(payload: RequestFlowReviewPayload): Promise<ApplyResult> {
  const slug = payload.project_slug;
  const startedAt = Date.now();
  let pending: CouncilRun | null = null;

  const result = await projectLocks.run(slug, async () => {
    const features = await readFeatures(slug);
    const i = features.findIndex((f) => f.id === payload.feature_id);
    if (i < 0) throw new ApplicatorError(`unknown feature: ${payload.feature_id}`, 404);
    const feat = features[i];
    if (feat.status !== "flowing" && feat.status !== "flow_review") {
      throw new ApplicatorError(
        `feature ${feat.id} is in status \`${feat.status}\` — flow_review is only valid from \`flowing\` (or rerun from \`flow_review\`).`,
        409,
      );
    }
    const flow = (await readFlows(slug)).find((f) => f.feature_id === feat.id);
    if (!flow || flow.nodes.length === 0) {
      throw new ApplicatorError(
        "feature has no flow yet — add at least one node before requesting review.",
        409,
      );
    }

    pending = {
      id: shortId("council"),
      project_slug: slug,
      feature_id: feat.id,
      type: "flow_review",
      status: "pending",
      started_at: startedAt,
    };
    await saveRun(pending);

    features[i] = { ...feat, status: "flow_review", updated_at: Date.now() };
    await writeFeatures(slug, features);

    return {
      scope: { kind: "project" as const, slug },
      result: { run: pending, feature: features[i] },
    };
  });

  if (pending) {
    // Broadcast pending event before kicking the runner so subscribers see
    // the in-flight state immediately. Actual run dispatch is fire-and-forget.
    events.broadcast({
      type: "council_run_pending",
      project_slug: slug,
      feature_id: payload.feature_id,
      run_id: (pending as CouncilRun).id,
      run_type: "flow_review",
      ts: Date.now(),
    });
    getCouncilRunner().fireAndForget(pending);
  }
  return result;
}

async function applyRequestTaskPlanning(payload: RequestTaskPlanningPayload): Promise<ApplyResult> {
  const slug = payload.project_slug;
  const startedAt = Date.now();
  let pending: CouncilRun | null = null;

  const result = await projectLocks.run(slug, async () => {
    const features = await readFeatures(slug);
    const i = features.findIndex((f) => f.id === payload.feature_id);
    if (i < 0) throw new ApplicatorError(`unknown feature: ${payload.feature_id}`, 404);
    const feat = features[i];
    if (feat.status !== "flow_approved" && feat.status !== "planning") {
      throw new ApplicatorError(
        `feature ${feat.id} is in status \`${feat.status}\` — task_planning requires the flow to be approved first.`,
        409,
      );
    }

    // Architecture gate: the council can't plan tasks against a fuzzy
    // architecture. The project must have at least one service AND a
    // current `approved_at` stamp on architecture.json. Edits to the
    // architecture clear approved_at, so this self-heals.
    const arch = await readArchitecture(slug);
    if (arch.services.length === 0) {
      throw new ApplicatorError(
        "task_planning blocked — the project's architecture is empty. Add at least one service on the Architecture tab and approve it before planning tasks.",
        409,
      );
    }
    if (!arch.approved_at) {
      throw new ApplicatorError(
        "task_planning blocked — the project's architecture has not been approved (or was edited since the last approval). Open the Architecture tab and click Approve.",
        409,
      );
    }

    pending = {
      id: shortId("council"),
      project_slug: slug,
      feature_id: feat.id,
      type: "task_planning",
      status: "pending",
      started_at: startedAt,
    };
    await saveRun(pending);

    features[i] = { ...feat, status: "planning", updated_at: Date.now() };
    await writeFeatures(slug, features);

    return {
      scope: { kind: "project" as const, slug },
      result: { run: pending, feature: features[i] },
    };
  });

  if (pending) {
    events.broadcast({
      type: "council_run_pending",
      project_slug: slug,
      feature_id: payload.feature_id,
      run_id: (pending as CouncilRun).id,
      run_type: "task_planning",
      ts: Date.now(),
    });
    getCouncilRunner().fireAndForget(pending);
  }
  return result;
}

async function applyApproveFlow(payload: ApproveFlowPayload): Promise<ApplyResult> {
  return await projectLocks.run(payload.project_slug, async () => {
    const features = await readFeatures(payload.project_slug);
    const i = features.findIndex((f) => f.id === payload.feature_id);
    if (i < 0) throw new ApplicatorError(`unknown feature: ${payload.feature_id}`, 404);
    const feat = features[i];
    if (feat.status !== "flow_review" && feat.status !== "flowing") {
      throw new ApplicatorError(
        `feature ${feat.id} is in status \`${feat.status}\` — approve_flow is only valid from \`flow_review\` or \`flowing\`.`,
        409,
      );
    }

    // The optional run_id is informational — used by the UI to associate
    // the approval with the artifact the user looked at — but server-side
    // we don't persist it on the feature record yet. (We can add a small
    // "approval log" later if Phase 5 needs it.)
    if (payload.run_id) {
      const run = await latestRun(payload.project_slug, feat.id, "flow_review");
      if (run && run.id !== payload.run_id) {
        // Not fatal — just nudge the user that they're approving against a
        // stale council run. We allow it because the user might have
        // re-read an older artifact intentionally.
      }
    }

    features[i] = { ...feat, status: "flow_approved", updated_at: Date.now() };
    await writeFeatures(payload.project_slug, features);

    return {
      scope: { kind: "project", slug: payload.project_slug },
      result: { feature: features[i] },
    };
  });
}

async function applyRequestFlowChanges(payload: RequestFlowChangesPayload): Promise<ApplyResult> {
  return await projectLocks.run(payload.project_slug, async () => {
    const features = await readFeatures(payload.project_slug);
    const i = features.findIndex((f) => f.id === payload.feature_id);
    if (i < 0) throw new ApplicatorError(`unknown feature: ${payload.feature_id}`, 404);
    const feat = features[i];
    if (feat.status !== "flow_review") {
      throw new ApplicatorError(
        `feature ${feat.id} is in status \`${feat.status}\` — request_flow_changes is only valid from \`flow_review\`.`,
        409,
      );
    }
    features[i] = { ...feat, status: "flowing", updated_at: Date.now() };
    await writeFeatures(payload.project_slug, features);

    return {
      scope: { kind: "project", slug: payload.project_slug },
      result: { feature: features[i], notes: payload.notes },
    };
  });
}

async function applyApproveTasks(payload: ApproveTasksPayload): Promise<ApplyResult> {
  return await projectLocks.run(payload.project_slug, async () => {
    const features = await readFeatures(payload.project_slug);
    const fi = features.findIndex((f) => f.id === payload.feature_id);
    if (fi < 0) throw new ApplicatorError(`unknown feature: ${payload.feature_id}`, 404);
    const feat = features[fi];
    if (feat.status !== "planning") {
      throw new ApplicatorError(
        `feature ${feat.id} is in status \`${feat.status}\` — approve_tasks is only valid from \`planning\`.`,
        409,
      );
    }

    const tasks = await readTasks(payload.project_slug);
    const keepSet = new Set(payload.task_ids);
    const now = Date.now();

    const proposedForFeature = tasks.filter(
      (t) => t.feature_id === feat.id && t.proposed === true,
    );
    if (proposedForFeature.length === 0) {
      throw new ApplicatorError(
        `feature ${feat.id} has no proposed tasks — run task_planning first.`,
        409,
      );
    }

    let approved = 0;
    let dropped = 0;
    const next: Task[] = [];
    for (const t of tasks) {
      const isProposedForThisFeature = t.feature_id === feat.id && t.proposed === true;
      if (!isProposedForThisFeature) {
        next.push(t);
        continue;
      }
      if (keepSet.has(t.id)) {
        next.push({ ...t, proposed: false, updated_at: now });
        approved++;
      } else {
        dropped++;
        // Filtered out (un-approved proposal).
      }
    }

    if (approved === 0) {
      throw new ApplicatorError(
        "task_ids matched zero proposed tasks for this feature — nothing to approve.",
        400,
      );
    }

    features[fi] = { ...feat, status: "planned", updated_at: now };
    await writeFeatures(payload.project_slug, features);
    await writeTasks(payload.project_slug, next);

    return {
      scope: { kind: "project", slug: payload.project_slug },
      result: {
        feature: features[fi],
        approved_count: approved,
        dropped_count: dropped,
      },
    };
  });
}

// ---- Queue applicators ----

async function applyStartQueue(payload: StartQueuePayload): Promise<ApplyResult> {
  // Validate slug if provided.
  if (payload.project_slug) {
    const fleet = await readFleet();
    if (!fleet.projects.some((p) => p.slug === payload.project_slug)) {
      throw new ApplicatorError(`unknown project: ${payload.project_slug}`, 404);
    }
  }
  getQueueWorker().start({ project_slug: payload.project_slug });
  const snap = getQueueWorker().snapshot();
  return {
    scope: payload.project_slug
      ? { kind: "project", slug: payload.project_slug }
      : { kind: "global" },
    result: { state: snap.state, current: snap.current },
  };
}

async function applyPauseQueue(payload: PauseQueuePayload): Promise<ApplyResult> {
  getQueueWorker().pause(payload.note);
  const snap = getQueueWorker().snapshot();
  return { scope: { kind: "global" }, result: { state: snap.state } };
}

async function applyStopQueue(payload: StopQueuePayload): Promise<ApplyResult> {
  getQueueWorker().stop(payload.note);
  const snap = getQueueWorker().snapshot();
  return { scope: { kind: "global" }, result: { state: snap.state } };
}

async function applyStartTask(payload: StartTaskPayload): Promise<ApplyResult> {
  // Async fire-and-forget; the run is observable via WS task_* events.
  const worker = getQueueWorker();
  void worker.runOne(payload.project_slug, payload.task_id).catch((err) => {
    console.error("[start_task] runOne failed:", err);
  });
  return {
    scope: { kind: "project", slug: payload.project_slug },
    result: { task_id: payload.task_id, accepted: true },
  };
}

async function applyCompleteTask(payload: CompleteTaskPayload): Promise<ApplyResult> {
  return await projectLocks.run(payload.project_slug, async () => {
    const tasks = await readTasks(payload.project_slug);
    const i = tasks.findIndex((t) => t.id === payload.task_id);
    if (i < 0) throw new ApplicatorError(`unknown task: ${payload.task_id}`, 404);
    tasks[i] = { ...tasks[i], status: "done", updated_at: Date.now() };
    await writeTasks(payload.project_slug, tasks);

    // If the parent feature has all tasks done, flip it to `done` too.
    const featureId = tasks[i].feature_id;
    if (featureId) {
      const remaining = tasks.filter(
        (t) => t.feature_id === featureId && t.status !== "done" && t.status !== "stale",
      );
      if (remaining.length === 0) {
        const features = await readFeatures(payload.project_slug);
        const fi = features.findIndex((f) => f.id === featureId);
        if (fi >= 0 && features[fi].status !== "done") {
          features[fi] = { ...features[fi], status: "done", updated_at: Date.now() };
          await writeFeatures(payload.project_slug, features);
        }
      } else {
        // Otherwise mark the feature `in_progress` if it was just `planned`.
        const features = await readFeatures(payload.project_slug);
        const fi = features.findIndex((f) => f.id === featureId);
        if (fi >= 0 && features[fi].status === "planned") {
          features[fi] = { ...features[fi], status: "in_progress", updated_at: Date.now() };
          await writeFeatures(payload.project_slug, features);
        }
      }
    }

    return {
      scope: { kind: "project", slug: payload.project_slug },
      result: {
        task: tasks[i],
        summary: payload.summary,
        artifacts: payload.artifacts ?? [],
      },
    };
  });
}

async function applyFailTask(payload: FailTaskPayload): Promise<ApplyResult> {
  return await projectLocks.run(payload.project_slug, async () => {
    const tasks = await readTasks(payload.project_slug);
    const i = tasks.findIndex((t) => t.id === payload.task_id);
    if (i < 0) throw new ApplicatorError(`unknown task: ${payload.task_id}`, 404);
    // Drop the task back to `todo` and surface a question so the picker
    // skips it until the user dismisses or answers (which also clears the
    // gate). This is the simplest path that stays inside the existing
    // lifecycle without inventing a `failed` task status.
    tasks[i] = { ...tasks[i], status: "todo", updated_at: Date.now() };
    await writeTasks(payload.project_slug, tasks);

    const questions = await readQuestions(payload.project_slug);
    const question: Question = {
      id: shortId("q"),
      project_slug: payload.project_slug,
      task_id: payload.task_id,
      body: `Task failed: ${payload.reason}`,
      asked_at: Date.now(),
      status: "open",
    };
    questions.unshift(question);
    await writeQuestions(payload.project_slug, questions);

    return {
      scope: { kind: "project", slug: payload.project_slug },
      result: { task: tasks[i], question },
    };
  });
}

async function applyEnqueueQuestion(payload: EnqueueQuestionPayload): Promise<ApplyResult> {
  return await projectLocks.run(payload.project_slug, async () => {
    const tasks = await readTasks(payload.project_slug);
    const i = tasks.findIndex((t) => t.id === payload.task_id);
    if (i < 0) throw new ApplicatorError(`unknown task: ${payload.task_id}`, 404);
    // Drop back to `todo` so the picker re-evaluates after the user
    // answers; the picker also blocks tasks with open questions, so
    // this won't immediately get re-picked.
    tasks[i] = { ...tasks[i], status: "todo", updated_at: Date.now() };
    await writeTasks(payload.project_slug, tasks);

    const questions = await readQuestions(payload.project_slug);
    const question: Question = {
      id: shortId("q"),
      project_slug: payload.project_slug,
      task_id: payload.task_id,
      body: payload.body,
      options: payload.options,
      asked_at: Date.now(),
      status: "open",
    };
    questions.unshift(question);
    await writeQuestions(payload.project_slug, questions);

    return {
      scope: { kind: "project", slug: payload.project_slug },
      result: { task: tasks[i], question },
    };
  });
}

async function applyAnswerQuestion(payload: AnswerQuestionPayload): Promise<ApplyResult> {
  return await projectLocks.run(payload.project_slug, async () => {
    const questions = await readQuestions(payload.project_slug);
    const i = questions.findIndex((q) => q.id === payload.question_id);
    if (i < 0) throw new ApplicatorError(`unknown question: ${payload.question_id}`, 404);
    if (questions[i].status !== "open") {
      throw new ApplicatorError(
        `question ${payload.question_id} is ${questions[i].status} (not open)`,
        409,
      );
    }
    questions[i] = {
      ...questions[i],
      status: "answered",
      answer: payload.answer,
      answer_choice: payload.choice,
      answered_at: Date.now(),
    };
    await writeQuestions(payload.project_slug, questions);
    return {
      scope: { kind: "project", slug: payload.project_slug },
      result: { question: questions[i] },
    };
  });
}

async function applyDismissQuestion(payload: DismissQuestionPayload): Promise<ApplyResult> {
  return await projectLocks.run(payload.project_slug, async () => {
    const questions = await readQuestions(payload.project_slug);
    const i = questions.findIndex((q) => q.id === payload.question_id);
    if (i < 0) throw new ApplicatorError(`unknown question: ${payload.question_id}`, 404);
    questions[i] = {
      ...questions[i],
      status: "dismissed",
      dismissed_at: Date.now(),
    };
    await writeQuestions(payload.project_slug, questions);
    return {
      scope: { kind: "project", slug: payload.project_slug },
      result: { question: questions[i] },
    };
  });
}

// ---- Architecture applicators (Phase 8) ----

async function applyAddService(payload: AddServicePayload): Promise<ApplyResult> {
  return await projectLocks.run(payload.project_slug, async () => {
    const arch = await readArchitecture(payload.project_slug);
    const id = shortId("svc");
    const service = {
      id,
      name: payload.name,
      kind: payload.kind ?? ("service" as const),
      description: payload.description,
      x: payload.x ?? defaultX(arch.services.length),
      y: payload.y ?? defaultY(arch.services.length),
    };
    arch.services.push(service);
    arch.updated_at = Date.now();
    invalidateArchitectureApproval(arch);
    await writeArchitecture(payload.project_slug, arch);
    return {
      scope: { kind: "project", slug: payload.project_slug },
      result: { service },
    };
  });
}

async function applyUpdateService(payload: UpdateServicePayload): Promise<ApplyResult> {
  return await projectLocks.run(payload.project_slug, async () => {
    const arch = await readArchitecture(payload.project_slug);
    const i = arch.services.findIndex((s) => s.id === payload.service_id);
    if (i < 0) throw new ApplicatorError(`unknown service: ${payload.service_id}`, 404);
    const prev = arch.services[i];
    const updated = { ...prev };
    if (payload.name !== undefined) updated.name = payload.name;
    if (payload.kind !== undefined) updated.kind = payload.kind;
    if (payload.description !== undefined) updated.description = payload.description;
    if (payload.x !== undefined) updated.x = payload.x;
    if (payload.y !== undefined) updated.y = payload.y;
    arch.services[i] = updated;
    arch.updated_at = Date.now();
    // Position-only updates don't invalidate the approval — the user is
    // just rearranging boxes on the canvas, not changing the architecture.
    const semanticChange =
      updated.name !== prev.name ||
      updated.kind !== prev.kind ||
      updated.description !== prev.description;
    if (semanticChange) invalidateArchitectureApproval(arch);
    await writeArchitecture(payload.project_slug, arch);
    return {
      scope: { kind: "project", slug: payload.project_slug },
      result: { service: updated },
    };
  });
}

async function applyRemoveService(payload: RemoveServicePayload): Promise<ApplyResult> {
  return await projectLocks.run(payload.project_slug, async () => {
    const arch = await readArchitecture(payload.project_slug);
    const i = arch.services.findIndex((s) => s.id === payload.service_id);
    if (i < 0) throw new ApplicatorError(`unknown service: ${payload.service_id}`, 404);
    const removed = arch.services.splice(i, 1)[0];
    // Cascade incident edges so the graph never carries dangling references.
    arch.edges = arch.edges.filter(
      (e) => e.from_service_id !== payload.service_id && e.to_service_id !== payload.service_id,
    );
    arch.updated_at = Date.now();
    invalidateArchitectureApproval(arch);
    await writeArchitecture(payload.project_slug, arch);
    return {
      scope: { kind: "project", slug: payload.project_slug },
      result: { removed },
    };
  });
}

async function applyAddArchEdge(payload: AddArchEdgePayload): Promise<ApplyResult> {
  return await projectLocks.run(payload.project_slug, async () => {
    const arch = await readArchitecture(payload.project_slug);
    const fromId = resolveServiceRef(
      arch,
      payload.from_service_id,
      payload.from_service_name,
      "from",
    );
    const toId = resolveServiceRef(
      arch,
      payload.to_service_id,
      payload.to_service_name,
      "to",
    );
    if (fromId === toId) {
      throw new ApplicatorError("from and to must differ", 400);
    }
    const dup = arch.edges.find(
      (e) => e.from_service_id === fromId && e.to_service_id === toId,
    );
    if (dup) {
      throw new ApplicatorError(`duplicate edge ${fromId}→${toId}`, 409);
    }
    const edge = {
      id: shortId("ae"),
      from_service_id: fromId,
      to_service_id: toId,
      label: payload.label,
      kind: payload.kind,
    };
    arch.edges.push(edge);
    arch.updated_at = Date.now();
    invalidateArchitectureApproval(arch); // edits force re-approval
    await writeArchitecture(payload.project_slug, arch);
    return {
      scope: { kind: "project", slug: payload.project_slug },
      result: { edge },
    };
  });
}

async function applyRemoveArchEdge(payload: RemoveArchEdgePayload): Promise<ApplyResult> {
  return await projectLocks.run(payload.project_slug, async () => {
    const arch = await readArchitecture(payload.project_slug);
    const i = arch.edges.findIndex((e) => e.id === payload.edge_id);
    if (i < 0) throw new ApplicatorError(`unknown edge: ${payload.edge_id}`, 404);
    const removed = arch.edges.splice(i, 1)[0];
    arch.updated_at = Date.now();
    invalidateArchitectureApproval(arch);
    await writeArchitecture(payload.project_slug, arch);
    return {
      scope: { kind: "project", slug: payload.project_slug },
      result: { removed },
    };
  });
}

/**
 * Approving the architecture unlocks `request_task_planning` on any
 * feature in the project. Empty architectures are rejected — we want at
 * least one service before saying "yes, this is the plan".
 */
async function applyApproveArchitecture(
  payload: ApproveArchitecturePayload,
): Promise<ApplyResult> {
  return await projectLocks.run(payload.project_slug, async () => {
    const arch = await readArchitecture(payload.project_slug);
    if (arch.services.length === 0) {
      throw new ApplicatorError(
        "architecture is empty — add at least one service before approving",
        400,
      );
    }
    arch.approved_at = Date.now();
    arch.updated_at = Date.now();
    await writeArchitecture(payload.project_slug, arch);
    return {
      scope: { kind: "project", slug: payload.project_slug },
      result: { approved_at: arch.approved_at },
    };
  });
}

async function applyUnapproveArchitecture(
  payload: UnapproveArchitecturePayload,
): Promise<ApplyResult> {
  return await projectLocks.run(payload.project_slug, async () => {
    const arch = await readArchitecture(payload.project_slug);
    arch.approved_at = undefined;
    arch.updated_at = Date.now();
    await writeArchitecture(payload.project_slug, arch);
    return {
      scope: { kind: "project", slug: payload.project_slug },
      result: { approved_at: null },
    };
  });
}

/**
 * Phase 18 — kick off an architecture review council run.
 * Project-scoped (no feature_id), persisted under the
 * `_arch` sentinel directory. The chair's verdict drives
 * `approve_architecture` automatically when the runner finishes.
 *
 * Pre-conditions:
 *   - architecture must have at least one service (otherwise the
 *     panel has nothing to evaluate).
 *
 * NOTE: deliberately does NOT auto-clear an existing approval —
 * a re-review of an already-approved architecture is fine and
 * doesn't need to block task_planning while the run is in flight.
 * If the chair returns request_changes, the existing approval
 * stays put; the user can manually `unapprove_architecture` if
 * they want to act on the new findings.
 */
async function applyRequestArchReview(payload: RequestArchReviewPayload): Promise<ApplyResult> {
  const slug = payload.project_slug;
  const startedAt = Date.now();
  let pending: CouncilRun | null = null;

  const result = await projectLocks.run(slug, async () => {
    const arch = await readArchitecture(slug);
    if (arch.services.length === 0) {
      throw new ApplicatorError(
        "architecture has no services yet — add at least one before requesting review.",
        409,
      );
    }
    pending = {
      id: shortId("council"),
      project_slug: slug,
      feature_id: PROJECT_SCOPED_FEATURE_ID,
      type: "architecture_review",
      status: "pending",
      started_at: startedAt,
    };
    await saveRun(pending);

    return {
      scope: { kind: "project" as const, slug },
      result: { run: pending },
    };
  });

  if (pending) {
    events.broadcast({
      type: "council_run_pending",
      project_slug: slug,
      feature_id: PROJECT_SCOPED_FEATURE_ID,
      run_id: (pending as CouncilRun).id,
      run_type: "architecture_review",
      ts: Date.now(),
    });
    getCouncilRunner().fireAndForget(pending);
  }
  return result;
}

/**
 * Phase 19 — flip voice on/off globally. Single boolean,
 * persisted in `store/settings.json`. Effect is immediate:
 *   - `disabled: true` → next health poll returns
 *     `disabled_by_user: true` (no upstream probe), all voice
 *     POST endpoints return 503.
 *   - `disabled: false` → upstream probe resumes; mic returns
 *     within one poll if the LAN is reachable.
 *
 * Broadcasts a `voice_settings_changed` event so all open
 * clients update without waiting for their next poll.
 */
async function applySetVoiceEnabled(payload: SetVoiceEnabledPayload): Promise<ApplyResult> {
  const next = await patchVoiceSettings({ disabled: !payload.enabled });
  events.broadcast({
    type: "voice_settings_changed",
    disabled: next.voice.disabled,
    ts: Date.now(),
  });
  return {
    scope: { kind: "global" },
    result: { voice: next.voice },
  };
}

/**
 * Phase 21 — agent-driven voice endpoint hot-swap.
 *
 * Routes to the same `patchVoiceEndpoints` storage helper the
 * direct PATCH endpoint uses, but skips the auth fields (they
 * never travel through chat). Broadcasts `voice_settings_changed`
 * so any open Settings tab refreshes its form and the sidebar
 * voice pill re-probes health on the new endpoint.
 */
async function applySetVoiceEndpoints(payload: SetVoiceEndpointsPayload): Promise<ApplyResult> {
  const next = await patchVoiceEndpoints(payload);
  events.broadcast({
    type: "voice_settings_changed",
    disabled: next.voice.disabled,
    ts: Date.now(),
  });
  return {
    scope: { kind: "global" },
    result: {
      voice: {
        stt: { url: next.voice.stt.url },
        tts: {
          url: next.voice.tts.url,
          voice: next.voice.tts.voice,
          language: next.voice.tts.language,
        },
      },
    },
  };
}

/**
 * Phase 20 — set the cursor-agent model used for chat / autonomous
 * agent paths. Either field can be omitted to leave that role
 * untouched, or passed as `""` to reset to the shipped default.
 *
 * Broadcasts `model_settings_changed` so any open client refreshes
 * its model dropdown UI without waiting for a poll.
 *
 * The mutation is system-wide (no per-project scope). We don't
 * expose project-level overrides in v1 — the same set of models
 * applies fleet-wide. If we add per-project overrides later they
 * stack on top of these, similar to the rules / personas pattern.
 */
async function applySetModels(payload: SetModelsPayload): Promise<ApplyResult> {
  const next = await patchModelSettings(payload);
  events.broadcast({
    type: "model_settings_changed",
    models: next.models,
    ts: Date.now(),
  });
  return {
    scope: { kind: "global" },
    result: { models: next.models },
  };
}

/** Resolve an architecture-edge endpoint by id (preferred) or service name. */
function resolveServiceRef(
  arch: { services: { id: string; name: string }[] },
  id: string | undefined,
  name: string | undefined,
  side: "from" | "to",
): string {
  if (id) {
    if (!arch.services.some((s) => s.id === id)) {
      throw new ApplicatorError(`${side}_service_id not in architecture: ${id}`, 404);
    }
    return id;
  }
  if (name) {
    for (let i = arch.services.length - 1; i >= 0; i--) {
      if (arch.services[i].name === name) return arch.services[i].id;
    }
    throw new ApplicatorError(
      `${side}_service_name not in architecture: "${name}"`,
      400,
    );
  }
  throw new ApplicatorError(`${side} endpoint requires an id or name`, 400);
}

/** Edits to the architecture force the user to re-approve before more
 *  task planning can run — keeps the planning gate honest. */
function invalidateArchitectureApproval(arch: { approved_at?: number }): void {
  arch.approved_at = undefined;
}

function defaultX(n: number): number {
  return 80 + (n % 4) * 220;
}
function defaultY(n: number): number {
  return 80 + Math.floor(n / 4) * 160;
}

// ---- Helpers ----

async function assertProject(slug: string): Promise<void> {
  const fleet = await readFleet();
  if (!fleet.projects.some((p) => p.slug === slug)) {
    throw new ApplicatorError(`unknown project slug: ${slug}`, 404);
  }
}

/**
 * Resolve a flow-node endpoint reference to a node id.
 *
 * Preferred form: `id` field. Fallback: `label` (last-matching node wins,
 * which matches the agent's intent of "the node I just emitted"). Throws
 * if neither form matches anything in the current flow.
 */
function resolveNodeRef(
  flow: { nodes: { id: string; label: string }[] },
  id: string | undefined,
  label: string | undefined,
  side: "from" | "to",
): string {
  if (id) {
    if (!flow.nodes.some((n) => n.id === id)) {
      throw new ApplicatorError(`${side}_node_id not in flow: ${id}`, 400);
    }
    return id;
  }
  if (label) {
    // Most-recent match wins, so a same-turn node-then-edge sequence
    // resolves to the freshly-added node.
    for (let i = flow.nodes.length - 1; i >= 0; i--) {
      if (flow.nodes[i].label === label) return flow.nodes[i].id;
    }
    throw new ApplicatorError(
      `${side}_node_label not in flow: "${label}" (no node with that label exists yet)`,
      400,
    );
  }
  throw new ApplicatorError(`${side} endpoint requires an id or label`, 400);
}

/** A node added to a `draft` feature implicitly bumps it into `flowing`. */
function bumpFeatureToFlowing(features: Feature[], feat: Feature): void {
  if (feat.status === "draft") {
    feat.status = "flowing";
    feat.updated_at = Date.now();
    const i = features.findIndex((f) => f.id === feat.id);
    if (i >= 0) features[i] = feat;
  }
}

/**
 * Stale-on-edit: if a flow mutation lands on a feature whose flow has
 * already been approved or beyond, drop it back to `flowing` and mark all
 * non-terminal feature-attached tasks as `stale` (queue-ineligible until
 * a Replan cycle promotes them back to `todo`).
 *
 * Caller must hold the project lock and pass the in-memory `features`
 * array; the staleness adjustment is applied directly. Tasks are written
 * to disk here.
 */
async function applyStaleOnEdit(
  slug: string,
  features: Feature[],
  feat: Feature,
): Promise<{ stale_tasks?: number }> {
  const APPROVED_OR_BEYOND: ReadonlySet<Feature["status"]> = new Set([
    "flow_approved",
    "planning",
    "planned",
    "in_progress",
    "done",
  ]);
  if (!APPROVED_OR_BEYOND.has(feat.status)) return {};

  feat.status = "flowing";
  feat.updated_at = Date.now();
  const i = features.findIndex((f) => f.id === feat.id);
  if (i >= 0) features[i] = feat;

  const tasks = await readTasks(slug);
  let staled = 0;
  const now = Date.now();
  const next = tasks.map((t) => {
    if (t.feature_id !== feat.id) return t;
    if (t.status === "done" || t.status === "stale") return t;
    staled++;
    return { ...t, status: "stale" as const, updated_at: now };
  });
  if (staled > 0) await writeTasks(slug, next);
  return { stale_tasks: staled };
}

/** Default canvas placement: stagger nodes diagonally for newcomers. */
function defaultNodeX(index: number): number {
  return 80 + (index % 4) * 220;
}
function defaultNodeY(index: number): number {
  return 80 + Math.floor(index / 4) * 140;
}

export class ApplicatorError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
    this.name = "ApplicatorError";
  }
}

// ---- Tools (Phase 10) ----

/**
 * Validate a tool's params against itself: reject duplicate names and
 * enum types missing options. Schema-level Zod validation is necessary
 * but not sufficient — these are cross-field checks the discriminated
 * union can't express cleanly.
 */
function validateToolParams(params: Tool["params"]): void {
  const seen = new Set<string>();
  for (const p of params) {
    if (seen.has(p.name)) {
      throw new ApplicatorError(`duplicate tool param name: ${p.name}`, 400);
    }
    seen.add(p.name);
    if (p.type === "enum" && (!p.options || p.options.length === 0)) {
      throw new ApplicatorError(`enum param ${p.name} requires at least one option`, 400);
    }
    if (p.default && p.type === "enum" && p.options && !p.options.includes(p.default)) {
      throw new ApplicatorError(
        `default for enum param ${p.name} (${p.default}) is not in options`,
        400,
      );
    }
  }
}

async function applyCreateTool(payload: CreateToolPayload): Promise<ApplyResult> {
  return await globalLocks.run("tools", async () => {
    const params = payload.params ?? [];
    validateToolParams(params);
    const tools = await readTools();
    const taken = activeToolSlugs(tools);
    const proposed = payload.slug ?? nameToSlug(payload.name);
    // Explicit slug must NOT collide. Auto-derived slug auto-dedupes.
    let slug: string;
    if (payload.slug) {
      if (taken.has(payload.slug)) {
        throw new ApplicatorError(`tool slug already taken: ${payload.slug}`, 409);
      }
      slug = payload.slug;
    } else {
      slug = dedupeSlug(proposed, taken);
    }
    const now = Date.now();
    const tool: Tool = {
      id: shortId("tool"),
      slug,
      name: payload.name,
      description: payload.description,
      category: payload.category,
      prompt_template: payload.prompt_template,
      params,
      status: "active",
      created_at: now,
      updated_at: now,
    };
    tools.unshift(tool);
    await writeTools(tools);
    return { scope: { kind: "global" }, result: { tool } };
  });
}

async function applyUpdateTool(payload: UpdateToolPayload): Promise<ApplyResult> {
  return await globalLocks.run("tools", async () => {
    const tools = await readTools();
    const tool = tools.find((t) => t.id === payload.tool_id);
    if (!tool) throw new ApplicatorError(`unknown tool: ${payload.tool_id}`, 404);
    if (payload.slug !== undefined && payload.slug !== tool.slug) {
      // Renaming a slug must not collide with another *active* tool.
      const taken = new Set(
        tools
          .filter((t) => t.status === "active" && t.id !== tool.id)
          .map((t) => t.slug),
      );
      if (taken.has(payload.slug)) {
        throw new ApplicatorError(`tool slug already taken: ${payload.slug}`, 409);
      }
      tool.slug = payload.slug;
    }
    if (payload.name !== undefined) tool.name = payload.name;
    if (payload.description !== undefined) tool.description = payload.description;
    if (payload.category !== undefined) tool.category = payload.category;
    if (payload.prompt_template !== undefined) tool.prompt_template = payload.prompt_template;
    if (payload.params !== undefined) {
      validateToolParams(payload.params);
      tool.params = payload.params;
    }
    tool.updated_at = Date.now();
    await writeTools(tools);
    return { scope: { kind: "global" }, result: { tool } };
  });
}

function activeToolSlugs(tools: Tool[]): Set<string> {
  return new Set(tools.filter((t) => t.status === "active").map((t) => t.slug));
}

async function applyArchiveTool(payload: ArchiveToolPayload): Promise<ApplyResult> {
  return await globalLocks.run("tools", async () => {
    const tools = await readTools();
    const tool = tools.find((t) => t.id === payload.tool_id);
    if (!tool) throw new ApplicatorError(`unknown tool: ${payload.tool_id}`, 404);
    tool.status = "archived";
    tool.updated_at = Date.now();
    await writeTools(tools);
    return { scope: { kind: "global" }, result: { tool } };
  });
}

// ---- Tool Proposals (Phase 13) ----
//
// `propose_tool` persists a pending suggestion. `accept_tool_proposal`
// builds a `CreateToolPayload` from `proposal + overrides` and runs
// the same `applyCreateTool` path the chat / UI would, then flips the
// proposal's status and stamps `tool_id`. `reject_tool_proposal`
// soft-deletes (status: "rejected"). All three serialize on the
// `tool_proposals` global lock; accept additionally takes the `tools`
// lock via the inner applyCreateTool call.

async function applyProposeTool(payload: ProposeToolPayload): Promise<ApplyResult> {
  return await globalLocks.run("tool_proposals", async () => {
    if (payload.params) validateToolParams(payload.params);
    const proposals = await readToolProposals();
    const now = Date.now();
    const proposal: ToolProposal = {
      id: shortId("tprop"),
      status: "pending",
      name: payload.name,
      description: payload.description,
      category: payload.category,
      prompt_template: payload.prompt_template,
      params: payload.params,
      rationale: payload.rationale,
      source: payload.source,
      created_at: now,
      updated_at: now,
    };
    proposals.unshift(proposal);
    await writeToolProposals(proposals);
    return { scope: { kind: "global" }, result: { proposal } };
  });
}

async function applyAcceptToolProposal(
  payload: AcceptToolProposalPayload,
): Promise<ApplyResult> {
  // Read the proposal under its lock first so we can build the
  // `create_tool` payload safely; release before we take the `tools`
  // lock to avoid lock-order issues if the two registries ever share
  // a key in the future.
  const existing = await globalLocks.run("tool_proposals", async () => {
    const proposals = await readToolProposals();
    const p = proposals.find((x) => x.id === payload.proposal_id);
    if (!p) throw new ApplicatorError(`unknown proposal: ${payload.proposal_id}`, 404);
    if (p.status !== "pending") {
      throw new ApplicatorError(
        `proposal ${payload.proposal_id} is ${p.status}; only pending proposals can be accepted`,
        409,
      );
    }
    return p;
  });

  const o = payload.overrides ?? {};
  // Re-validate overridden params if provided, so the user can't
  // sneak through invalid shapes by going via a proposal.
  if (o.params !== undefined) validateToolParams(o.params);
  if (existing.params !== undefined && o.params === undefined) {
    validateToolParams(existing.params);
  }

  const created = await applyCreateTool({
    name: o.name ?? existing.name,
    slug: o.slug,
    description: o.description ?? existing.description,
    category: o.category ?? existing.category,
    prompt_template: o.prompt_template ?? existing.prompt_template,
    params: o.params ?? existing.params,
  });

  const tool = (created.result as { tool: Tool }).tool;

  // Stamp the proposal accepted and link the new tool.
  const proposal = await globalLocks.run("tool_proposals", async () => {
    const proposals = await readToolProposals();
    const i = proposals.findIndex((x) => x.id === payload.proposal_id);
    if (i < 0) {
      // Shouldn't happen — we just read it — but be defensive.
      throw new ApplicatorError(`proposal vanished: ${payload.proposal_id}`, 500);
    }
    proposals[i] = {
      ...proposals[i],
      status: "accepted",
      tool_id: tool.id,
      updated_at: Date.now(),
    };
    await writeToolProposals(proposals);
    return proposals[i];
  });

  return { scope: { kind: "global" }, result: { proposal, tool } };
}

async function applyRejectToolProposal(
  payload: RejectToolProposalPayload,
): Promise<ApplyResult> {
  return await globalLocks.run("tool_proposals", async () => {
    const proposals = await readToolProposals();
    const i = proposals.findIndex((x) => x.id === payload.proposal_id);
    if (i < 0) {
      throw new ApplicatorError(`unknown proposal: ${payload.proposal_id}`, 404);
    }
    if (proposals[i].status !== "pending") {
      // Idempotent: rejecting an already-rejected proposal is a no-op
      // success; rejecting an accepted one is a 409 (would unlink the
      // tool from its proposal trail, which is not what we want).
      if (proposals[i].status === "accepted") {
        throw new ApplicatorError(
          `proposal ${payload.proposal_id} is already accepted`,
          409,
        );
      }
      return { scope: { kind: "global" }, result: { proposal: proposals[i] } };
    }
    proposals[i] = {
      ...proposals[i],
      status: "rejected",
      updated_at: Date.now(),
    };
    await writeToolProposals(proposals);
    return { scope: { kind: "global" }, result: { proposal: proposals[i] } };
  });
}

/**
 * `run_tool` is a convenience verb: it reads the tool, validates+coerces
 * args, then creates a Task carrying `tool_id` + `tool_args` and (when
 * `auto_start` is true) immediately spawns it on the queue worker. The
 * task takes the tool's name as its title unless the caller supplies an
 * override — keeps the task list readable.
 */
async function applyRunTool(payload: RunToolPayload): Promise<ApplyResult> {
  // Look up the tool outside the project lock; we only read here.
  const tools = await readTools();
  const tool = tools.find((t) => t.id === payload.tool_id && t.status === "active");
  if (!tool) {
    throw new ApplicatorError(`unknown or archived tool: ${payload.tool_id}`, 404);
  }
  let coerced: Record<string, string>;
  try {
    coerced = coerceArgs(tool.params, payload.args ?? {});
  } catch (err) {
    throw new ApplicatorError(err instanceof Error ? err.message : String(err), 400);
  }
  await assertProject(payload.project_slug);

  const task = await projectLocks.run(payload.project_slug, async () => {
    const tasks = await readTasks(payload.project_slug);
    const now = Date.now();
    const t: Task = {
      id: shortId("task"),
      project_slug: payload.project_slug,
      title: payload.title ?? `tool: ${tool.name}`,
      description: tool.description,
      status: "todo",
      priority: payload.priority,
      tool_id: tool.id,
      tool_args: coerced,
      created_at: now,
      updated_at: now,
    };
    tasks.unshift(t);
    await writeTasks(payload.project_slug, tasks);
    return t;
  });

  if (payload.auto_start) {
    // Fire and forget — runOne resolves when the task ends, but callers
    // of run_tool generally just want acknowledgement that the run was
    // dispatched. The queue UI surfaces progress live.
    void getQueueWorker()
      .runOne(payload.project_slug, task.id)
      .catch((err) => {
        console.error(`[run_tool] auto-start failed for task ${task.id}:`, err);
      });
  }

  return {
    scope: { kind: "project", slug: payload.project_slug },
    result: { task, tool_id: tool.id, auto_started: !!payload.auto_start },
  };
}

// ---- Cron (Phase 11) ----

async function applyCreateCron(
  payload: CreateCronPayload,
  ctx: ApplyContext,
): Promise<ApplyResult> {
  return await globalLocks.run("cron", async () => {
    try {
      parseCron(payload.schedule);
    } catch (err) {
      throw new ApplicatorError(err instanceof Error ? err.message : String(err), 400);
    }
    const target = await assertCronTarget(payload.target);
    const jobs = await readCronJobs();
    const now = Date.now();

    // Cron jobs always carry a slug now — it's the stable filesystem
    // identifier for standalone targets and a friendly label for the
    // others. Derived from `name`, deduped against existing slugs.
    const taken = new Set(jobs.map((j) => j.slug).filter((s): s is string => !!s));
    const slug = dedupeSlug(nameToSlug(payload.name, "cron"), taken);

    const job: CronJob = {
      id: shortId("cron"),
      slug,
      name: payload.name,
      description: payload.description,
      schedule: payload.schedule,
      target,
      enabled: payload.enabled ?? true,
      created_at: now,
      updated_at: now,
    };
    jobs.unshift(job);
    await writeCronJobs(jobs);

    // For standalone targets, mkdir -p the workspace + state dirs
    // eagerly so the runner doesn't race against the first tick.
    // Errors here are non-fatal (the runner will retry on each tick),
    // but we surface them so the user sees the problem early.
    if (target.kind === "standalone") {
      try {
        await ensureStandaloneDirs(slug, ctx.workspaceRoot);
      } catch (err) {
        console.warn(
          `[cron] failed to pre-create dirs for standalone job ${slug}:`,
          err,
        );
      }
    }
    return { scope: { kind: "global" }, result: { job } };
  });
}

async function applyUpdateCron(
  payload: UpdateCronPayload,
  ctx: ApplyContext,
): Promise<ApplyResult> {
  return await globalLocks.run("cron", async () => {
    const jobs = await readCronJobs();
    const job = jobs.find((j) => j.id === payload.cron_id);
    if (!job) throw new ApplicatorError(`unknown cron job: ${payload.cron_id}`, 404);
    if (payload.name !== undefined) job.name = payload.name;
    if (payload.description !== undefined) job.description = payload.description;
    if (payload.schedule !== undefined) {
      try {
        parseCron(payload.schedule);
      } catch (err) {
        throw new ApplicatorError(err instanceof Error ? err.message : String(err), 400);
      }
      job.schedule = payload.schedule;
    }
    if (payload.target !== undefined) {
      const newTarget = await assertCronTarget(payload.target);
      job.target = newTarget;
      // If the user flipped an existing job into standalone, make sure
      // its dirs exist. Backfill the slug for legacy rows that pre-date
      // the field — derived from `name` and deduped against siblings.
      if (newTarget.kind === "standalone") {
        if (!job.slug) {
          const taken = new Set(
            jobs
              .filter((j) => j.id !== job.id)
              .map((j) => j.slug)
              .filter((s): s is string => !!s),
          );
          job.slug = dedupeSlug(nameToSlug(job.name, "cron"), taken);
        }
        try {
          await ensureStandaloneDirs(job.slug, ctx.workspaceRoot);
        } catch (err) {
          console.warn(
            `[cron] failed to pre-create dirs for standalone job ${job.slug}:`,
            err,
          );
        }
      }
    }
    if (payload.enabled !== undefined) job.enabled = payload.enabled;
    job.updated_at = Date.now();
    await writeCronJobs(jobs);
    return { scope: { kind: "global" }, result: { job } };
  });
}

async function ensureStandaloneDirs(
  cronSlug: string,
  workspaceRoot: string,
): Promise<void> {
  await fs.mkdir(cronWorkspaceDir(workspaceRoot, cronSlug), { recursive: true });
  await fs.mkdir(cronTranscriptsDir(cronSlug), { recursive: true });
}

async function applyArchiveCron(payload: ArchiveCronPayload): Promise<ApplyResult> {
  return await globalLocks.run("cron", async () => {
    const jobs = await readCronJobs();
    const idx = jobs.findIndex((j) => j.id === payload.cron_id);
    if (idx < 0) throw new ApplicatorError(`unknown cron job: ${payload.cron_id}`, 404);
    const [removed] = jobs.splice(idx, 1);
    await writeCronJobs(jobs);
    return { scope: { kind: "global" }, result: { archived: removed.id } };
  });
}

async function applySetCronEnabled(payload: SetCronEnabledPayload): Promise<ApplyResult> {
  return await globalLocks.run("cron", async () => {
    const jobs = await readCronJobs();
    const job = jobs.find((j) => j.id === payload.cron_id);
    if (!job) throw new ApplicatorError(`unknown cron job: ${payload.cron_id}`, 404);
    job.enabled = payload.enabled;
    job.updated_at = Date.now();
    await writeCronJobs(jobs);
    return { scope: { kind: "global" }, result: { job } };
  });
}

async function applyRunCronNow(payload: RunCronNowPayload): Promise<ApplyResult> {
  // Read the job, then dispatch its target via the same path the
  // scheduler uses. We reuse `executeCronJob` so manual runs and
  // scheduled runs go through identical code.
  const jobs = await readCronJobs();
  const job = jobs.find((j) => j.id === payload.cron_id);
  if (!job) throw new ApplicatorError(`unknown cron job: ${payload.cron_id}`, 404);
  const { executeCronJob } = await import("../cron/scheduler.js");
  const result = await executeCronJob(job, { manual: true });
  return { scope: { kind: "global" }, result };
}

/**
 * Cross-field validation for a CronJob target. The discriminated union
 * shape catches the obvious type errors at the schema layer; this is
 * where we confirm referenced ids exist and resolve `tool_name` →
 * `tool_id` so the rest of the system always sees a concrete id.
 *
 * Returns a normalized target with `tool_name` stripped — same
 * convention as add_arch_edge resolving `from_service_name`. When the
 * name matches multiple tools, the most recently created active tool
 * wins (matches the agent's intent of "the tool I just made").
 */
type CronTargetInput =
  | { kind: "tool"; tool_id?: string; tool_name?: string; project_slug: string; args?: Record<string, string>; priority?: number }
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
  | {
      kind: "standalone";
      tool_id?: string;
      tool_name?: string;
      prompt?: string;
      args?: Record<string, string>;
    };

async function assertCronTarget(target: CronTargetInput): Promise<CronJob["target"]> {
  if (target.kind === "tool") {
    const tools = await readTools();
    let tool = target.tool_id
      ? tools.find((t) => t.id === target.tool_id && t.status === "active") ?? null
      : null;
    if (!tool && target.tool_name) {
      const candidates = tools
        .filter((t) => t.status === "active" && t.name === target.tool_name)
        .sort((a, b) => b.created_at - a.created_at);
      tool = candidates[0] ?? null;
    }
    if (!tool) {
      throw new ApplicatorError(
        `cron target tool not found: ${target.tool_id ?? target.tool_name}`,
        404,
      );
    }
    await assertProject(target.project_slug);
    if (target.args) {
      try {
        coerceArgs(tool.params, target.args);
      } catch (err) {
        throw new ApplicatorError(
          `cron tool args invalid: ${err instanceof Error ? err.message : String(err)}`,
          400,
        );
      }
    }
    return {
      kind: "tool",
      tool_id: tool.id,
      project_slug: target.project_slug,
      args: target.args,
      priority: target.priority,
    };
  }
  if (target.kind === "task") {
    await assertProject(target.project_slug);
    if (target.feature_id) {
      // Confirm the feature exists & isn't archived. Failing here at
      // create time is way better than failing silently every tick.
      const features = await readFeatures(target.project_slug);
      const feature = features.find(
        (f) => f.id === target.feature_id && f.status !== "archived",
      );
      if (!feature) {
        throw new ApplicatorError(
          `cron task feature_id not found in ${target.project_slug}: ${target.feature_id}`,
          404,
        );
      }
    }
    return {
      kind: "task",
      project_slug: target.project_slug,
      title: target.title,
      description: target.description,
      priority: target.priority,
      feature_id: target.feature_id,
      auto_start: target.auto_start,
    };
  }
  if (target.kind === "standalone") {
    // Phase 23: cron owns its own workspace. Either reference an
    // existing Tool (resolved by id-or-name like the `tool` target) or
    // ship an inline prompt. Schema's `.refine` already enforces XOR;
    // we just resolve the tool ref here when applicable.
    if (target.tool_id || target.tool_name) {
      const tools = await readTools();
      let tool = target.tool_id
        ? tools.find(
            (t) => t.id === target.tool_id && t.status === "active",
          ) ?? null
        : null;
      if (!tool && target.tool_name) {
        const candidates = tools
          .filter((t) => t.status === "active" && t.name === target.tool_name)
          .sort((a, b) => b.created_at - a.created_at);
        tool = candidates[0] ?? null;
      }
      if (!tool) {
        throw new ApplicatorError(
          `cron target tool not found: ${target.tool_id ?? target.tool_name}`,
          404,
        );
      }
      if (target.args) {
        try {
          coerceArgs(tool.params, target.args);
        } catch (err) {
          throw new ApplicatorError(
            `cron tool args invalid: ${err instanceof Error ? err.message : String(err)}`,
            400,
          );
        }
      }
      return {
        kind: "standalone",
        tool_id: tool.id,
        args: target.args,
      };
    }
    // Inline prompt path — schema already enforced length & exclusivity.
    return {
      kind: "standalone",
      prompt: target.prompt,
    };
  }
  if (target.project_slug) await assertProject(target.project_slug);
  return { kind: "queue", project_slug: target.project_slug };
}

// ---- Rules (Phase 12) ----
//
// Two-scope storage: global rules in `store/rules.json` (under
// globalLocks key "rules"), per-project rules in
// `store/<slug>/rules.json` (under `projectLocks(slug)`). Mutations
// dispatch into the right lock based on the payload's `scope`. Update
// / archive / set_enabled accept an optional `scope` fast-path; if
// absent we walk the fleet via `findRuleById`.

async function applyCreateRule(payload: CreateRulePayload): Promise<ApplyResult> {
  const now = Date.now();
  const base: Rule = {
    id: shortId("rule"),
    scope: payload.scope.kind,
    project_slug: payload.scope.kind === "project" ? payload.scope.project_slug : undefined,
    title: payload.title,
    body: payload.body,
    category: payload.category,
    enabled: payload.enabled ?? true,
    status: "active",
    created_at: now,
    updated_at: now,
  };
  if (payload.scope.kind === "global") {
    return await globalLocks.run("rules", async () => {
      const rules = await readGlobalRules();
      rules.unshift(base);
      await writeGlobalRules(rules);
      return { scope: { kind: "global" }, result: { rule: base } };
    });
  }
  const slug = payload.scope.project_slug;
  await assertProject(slug);
  return await projectLocks.run(slug, async () => {
    const rules = await readProjectRules(slug);
    rules.unshift(base);
    await writeProjectRules(slug, rules);
    return { scope: { kind: "project", slug }, result: { rule: base } };
  });
}

/**
 * Resolve the scope for an update/archive/set_enabled payload. When
 * `scope` is provided we trust it (cheap path for the UI which always
 * knows where the rule lives). Otherwise we scan global + every active
 * project. Returns `null` if the rule wasn't found anywhere.
 */
async function resolveRuleScope(
  ruleId: string,
  scope: UpdateRulePayload["scope"] | ArchiveRulePayload["scope"] | SetRuleEnabledPayload["scope"],
): Promise<{ kind: "global" } | { kind: "project"; slug: string } | null> {
  if (scope) {
    return scope.kind === "global"
      ? { kind: "global" }
      : { kind: "project", slug: scope.project_slug };
  }
  const fleet = await readFleet();
  const slugs = fleet.projects.filter((p) => p.status !== "archived").map((p) => p.slug);
  const found = await findRuleById(ruleId, slugs);
  if (!found) return null;
  return found.scope === "global" ? { kind: "global" } : { kind: "project", slug: found.project_slug };
}

async function withRuleLock<T>(
  scope: { kind: "global" } | { kind: "project"; slug: string },
  fn: () => Promise<T>,
): Promise<T> {
  return scope.kind === "global"
    ? globalLocks.run("rules", fn)
    : projectLocks.run(scope.slug, fn);
}

async function readRulesForScope(
  scope: { kind: "global" } | { kind: "project"; slug: string },
): Promise<Rule[]> {
  return scope.kind === "global" ? readGlobalRules() : readProjectRules(scope.slug);
}

async function writeRulesForScope(
  scope: { kind: "global" } | { kind: "project"; slug: string },
  rules: Rule[],
): Promise<void> {
  if (scope.kind === "global") return writeGlobalRules(rules);
  return writeProjectRules(scope.slug, rules);
}

async function applyUpdateRule(payload: UpdateRulePayload): Promise<ApplyResult> {
  const scope = await resolveRuleScope(payload.rule_id, payload.scope);
  if (!scope) throw new ApplicatorError(`unknown rule: ${payload.rule_id}`, 404);
  return await withRuleLock(scope, async () => {
    const rules = await readRulesForScope(scope);
    const i = rules.findIndex((r) => r.id === payload.rule_id);
    if (i < 0) throw new ApplicatorError(`unknown rule: ${payload.rule_id}`, 404);
    const next: Rule = { ...rules[i] };
    if (payload.title !== undefined) next.title = payload.title;
    if (payload.body !== undefined) next.body = payload.body;
    if (payload.category !== undefined) next.category = payload.category;
    if (payload.enabled !== undefined) next.enabled = payload.enabled;
    next.updated_at = Date.now();
    rules[i] = next;
    await writeRulesForScope(scope, rules);
    return {
      scope: scope.kind === "global" ? { kind: "global" } : { kind: "project", slug: scope.slug },
      result: { rule: next },
    };
  });
}

async function applyArchiveRule(payload: ArchiveRulePayload): Promise<ApplyResult> {
  const scope = await resolveRuleScope(payload.rule_id, payload.scope);
  if (!scope) throw new ApplicatorError(`unknown rule: ${payload.rule_id}`, 404);
  return await withRuleLock(scope, async () => {
    const rules = await readRulesForScope(scope);
    const i = rules.findIndex((r) => r.id === payload.rule_id);
    if (i < 0) throw new ApplicatorError(`unknown rule: ${payload.rule_id}`, 404);
    rules[i] = { ...rules[i], status: "archived", updated_at: Date.now() };
    await writeRulesForScope(scope, rules);
    return {
      scope: scope.kind === "global" ? { kind: "global" } : { kind: "project", slug: scope.slug },
      result: { rule: rules[i] },
    };
  });
}

async function applySetRuleEnabled(payload: SetRuleEnabledPayload): Promise<ApplyResult> {
  const scope = await resolveRuleScope(payload.rule_id, payload.scope);
  if (!scope) throw new ApplicatorError(`unknown rule: ${payload.rule_id}`, 404);
  return await withRuleLock(scope, async () => {
    const rules = await readRulesForScope(scope);
    const i = rules.findIndex((r) => r.id === payload.rule_id);
    if (i < 0) throw new ApplicatorError(`unknown rule: ${payload.rule_id}`, 404);
    rules[i] = { ...rules[i], enabled: payload.enabled, updated_at: Date.now() };
    await writeRulesForScope(scope, rules);
    return {
      scope: scope.kind === "global" ? { kind: "global" } : { kind: "project", slug: scope.slug },
      result: { rule: rules[i] },
    };
  });
}

// ---- Personas (Phase 14) ----
//
// Mirror of the Rules applicator surface. Two scopes (global +
// project), three verbs (create / update / archive). Locking matches
// Phase 12: globals serialize on the `personas` global lock; project
// personas serialize on the project lock so they don't race with
// other project mutations. The `scope?` on update/archive is a fast
// path; when omitted we walk the fleet via `findPersonaById`.

async function applyCreatePersona(payload: CreatePersonaPayload): Promise<ApplyResult> {
  const now = Date.now();
  const base: Persona = {
    id: shortId("persona"),
    scope: payload.scope.kind,
    project_slug: payload.scope.kind === "project" ? payload.scope.project_slug : undefined,
    key: payload.key,
    name: payload.name,
    description: payload.description,
    prompt_template: payload.prompt_template,
    accent: payload.accent,
    status: "active",
    created_at: now,
    updated_at: now,
  };
  if (payload.scope.kind === "global") {
    return await globalLocks.run("personas", async () => {
      const personas = await readGlobalPersonas();
      personas.unshift(base);
      await writeGlobalPersonas(personas);
      return { scope: { kind: "global" }, result: { persona: base } };
    });
  }
  const slug = payload.scope.project_slug;
  await assertProject(slug);
  return await projectLocks.run(slug, async () => {
    const personas = await readProjectPersonas(slug);
    personas.unshift(base);
    await writeProjectPersonas(slug, personas);
    return { scope: { kind: "project", slug }, result: { persona: base } };
  });
}

async function resolvePersonaScope(
  personaId: string,
  scope: UpdatePersonaPayload["scope"] | ArchivePersonaPayload["scope"],
): Promise<{ kind: "global" } | { kind: "project"; slug: string } | null> {
  if (scope) {
    return scope.kind === "global"
      ? { kind: "global" }
      : { kind: "project", slug: scope.project_slug };
  }
  const found = await findPersonaById(personaId);
  if (!found) return null;
  return found.scope === "global"
    ? { kind: "global" }
    : { kind: "project", slug: found.project_slug! };
}

async function withPersonaLock<T>(
  scope: { kind: "global" } | { kind: "project"; slug: string },
  fn: () => Promise<T>,
): Promise<T> {
  return scope.kind === "global"
    ? globalLocks.run("personas", fn)
    : projectLocks.run(scope.slug, fn);
}

async function readPersonasForScope(
  scope: { kind: "global" } | { kind: "project"; slug: string },
): Promise<Persona[]> {
  return scope.kind === "global" ? readGlobalPersonas() : readProjectPersonas(scope.slug);
}

async function writePersonasForScope(
  scope: { kind: "global" } | { kind: "project"; slug: string },
  personas: Persona[],
): Promise<void> {
  if (scope.kind === "global") return writeGlobalPersonas(personas);
  return writeProjectPersonas(scope.slug, personas);
}

async function applyUpdatePersona(payload: UpdatePersonaPayload): Promise<ApplyResult> {
  const scope = await resolvePersonaScope(payload.persona_id, payload.scope);
  if (!scope) throw new ApplicatorError(`unknown persona: ${payload.persona_id}`, 404);
  return await withPersonaLock(scope, async () => {
    const personas = await readPersonasForScope(scope);
    const i = personas.findIndex((p) => p.id === payload.persona_id);
    if (i < 0) throw new ApplicatorError(`unknown persona: ${payload.persona_id}`, 404);
    const next: Persona = { ...personas[i] };
    if (payload.key !== undefined) next.key = payload.key;
    if (payload.name !== undefined) next.name = payload.name;
    if (payload.description !== undefined) next.description = payload.description;
    if (payload.prompt_template !== undefined) next.prompt_template = payload.prompt_template;
    if (payload.accent !== undefined) next.accent = payload.accent;
    next.updated_at = Date.now();
    personas[i] = next;
    await writePersonasForScope(scope, personas);
    return {
      scope: scope.kind === "global" ? { kind: "global" } : { kind: "project", slug: scope.slug },
      result: { persona: next },
    };
  });
}

async function applyArchivePersona(payload: ArchivePersonaPayload): Promise<ApplyResult> {
  const scope = await resolvePersonaScope(payload.persona_id, payload.scope);
  if (!scope) throw new ApplicatorError(`unknown persona: ${payload.persona_id}`, 404);
  return await withPersonaLock(scope, async () => {
    const personas = await readPersonasForScope(scope);
    const i = personas.findIndex((p) => p.id === payload.persona_id);
    if (i < 0) throw new ApplicatorError(`unknown persona: ${payload.persona_id}`, 404);
    personas[i] = { ...personas[i], status: "archived", updated_at: Date.now() };
    await writePersonasForScope(scope, personas);
    return {
      scope: scope.kind === "global" ? { kind: "global" } : { kind: "project", slug: scope.slug },
      result: { persona: personas[i] },
    };
  });
}

// ---- Navigation (Phase 15) ----
//
// `navigate` is a non-mutating verb: it validates targets that
// reference real entities (so we don't trust the agent to invent a
// project slug or feature id) and broadcasts a `nav_request` WS
// event with the originating client's id. Clients honor only their
// own navigation requests.
//
// Validation rules:
//   - `kind:"global"` — always OK.
//   - `kind:"project"` — slug must exist on the active fleet.
//   - `kind:"feature"` — slug + feature_id must both exist.
//   - `kind:"task"` — slug + task_id must both exist.
//
// We deliberately don't fall back when the target is invalid — the
// agent is supposed to surface ambiguity via `add_question`. Sending
// a 404 forces it to retry the schema-retry loop with corrected ids
// or raise a question instead of silently dead-ending.

async function applyNavigate(payload: NavigatePayload, clientId?: string): Promise<ApplyResult> {
  // Phase 21 — resolve label-style references (project_name,
  // feature_name, task_name) to concrete ids. The schema already
  // enforced that at least one of the id/name pair is present.
  // After this block, `resolved` is shape-equivalent to the legacy
  // id-only form; clients keep the same handler.
  const resolved = await resolveNavigateTarget(payload.target);

  // Broadcast — fire-and-forget; in-process listeners + WS clients
  // both receive it. Clients filter on `client_id` to scope the
  // navigation to whoever issued the verb. We always broadcast the
  // *resolved* target (ids only) so clients don't have to know how
  // to dereference names.
  events.broadcast({
    type: "nav_request",
    client_id: clientId,
    target: resolved,
    reason: payload.reason,
    ts: Date.now(),
  });

  return {
    // No project lock taken; navigation is read-only on disk. Scope
    // the activity entry to project when applicable so the user can
    // audit voice routing per-project, otherwise to global.
    scope:
      resolved.kind === "project" || resolved.kind === "feature" || resolved.kind === "task"
        ? { kind: "project", slug: resolved.project_slug }
        : { kind: "global" },
    // Echo both the original (label-form) and the resolved (id-form)
    // target so the activity log preserves agent intent while still
    // showing the canonical ids that landed.
    result: { navigated: true, target: resolved, requested: payload.target, client_id: clientId },
  };
}

/**
 * Resolve a NavigatePayload target's name-form fields to concrete
 * ids. Throws ApplicatorError(404) on unresolvable names so the
 * agent's schema-retry loop sees a structured error rather than a
 * silent dead-end.
 *
 * Tie-breaking for ambiguous names: most recent `created_at` wins.
 * This matches user expectation when chaining
 *   add_feature { name: "Onboarding" }
 *   navigate { target: { kind: "feature", feature_name: "Onboarding", ... } }
 * — the freshly-created feature wins over an older one with the
 * same name.
 *
 * Returns a target object whose shape matches the legacy id-only
 * form (no `*_name` fields), so client code stays untouched.
 */
type ResolvedTarget =
  | { kind: "global"; tab?: string }
  | { kind: "project"; project_slug: string; tab?: string }
  | { kind: "feature"; project_slug: string; feature_id: string }
  | { kind: "task"; project_slug: string; task_id: string };

async function resolveNavigateTarget(target: NavigatePayload["target"]): Promise<ResolvedTarget> {
  if (target.kind === "global") return { kind: "global", tab: target.tab };

  // All non-global kinds need a project. Resolve the project first.
  const projectSlug = await resolveProjectRef(target.project_slug, target.project_name);

  if (target.kind === "project") {
    return { kind: "project", project_slug: projectSlug, tab: target.tab };
  }

  if (target.kind === "feature") {
    const features = await readFeatures(projectSlug);
    if (target.feature_id) {
      if (!features.some((f) => f.id === target.feature_id)) {
        throw new ApplicatorError(
          `unknown feature ${target.feature_id} in project ${projectSlug}`,
          404,
        );
      }
      return { kind: "feature", project_slug: projectSlug, feature_id: target.feature_id };
    }
    const want = (target.feature_name ?? "").toLowerCase();
    const matches = features
      .filter((f) => (f.name ?? "").toLowerCase() === want)
      .sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));
    if (matches.length === 0) {
      throw new ApplicatorError(
        `no feature named "${target.feature_name}" in project ${projectSlug}`,
        404,
      );
    }
    return { kind: "feature", project_slug: projectSlug, feature_id: matches[0].id };
  }

  // task
  const tasks = await readTasks(projectSlug);
  if (target.task_id) {
    if (!tasks.some((t) => t.id === target.task_id)) {
      throw new ApplicatorError(
        `unknown task ${target.task_id} in project ${projectSlug}`,
        404,
      );
    }
    return { kind: "task", project_slug: projectSlug, task_id: target.task_id };
  }
  const want = (target.task_name ?? "").toLowerCase();
  const matches = tasks
    .filter((t) => (t.title ?? "").toLowerCase() === want)
    .sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));
  if (matches.length === 0) {
    throw new ApplicatorError(
      `no task titled "${target.task_name}" in project ${projectSlug}`,
      404,
    );
  }
  return { kind: "task", project_slug: projectSlug, task_id: matches[0].id };
}

/** Resolve project_slug | project_name → slug (most recent on tie). */
async function resolveProjectRef(slug?: string, name?: string): Promise<string> {
  if (slug) {
    await assertProject(slug);
    return slug;
  }
  if (!name) throw new ApplicatorError("project reference required", 400);
  const fleet = await readFleet();
  const want = name.toLowerCase();
  const matches = fleet.projects
    .filter((p) => p.status !== "archived" && (p.name ?? "").toLowerCase() === want)
    .sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));
  if (matches.length === 0) {
    throw new ApplicatorError(`no project named "${name}"`, 404);
  }
  return matches[0].slug;
}
