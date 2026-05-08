import { readFleet } from "../storage/fleet.js";
import {
  readArchitecture,
  readFeatures,
  readFlows,
  readTasks,
} from "../storage/entities.js";

/**
 * Phase 16 — coach hints.
 *
 * Icarus's flow has a natural lifecycle: project → feature → flow →
 * council review → architecture → council approval → tasks → queue.
 * Without guidance the agent answers reactively — wait for the user
 * to ask, then do the thing. That works for power users; it's
 * miserable for "I want to build something but don't know where to
 * start."
 *
 * The coach hint is a small directive block, prepended to every
 * cursor-agent turn just before the user text, that interprets the
 * current world state into the next focused question to ask. The
 * project context block already tells the agent *what is* — the
 * hint tells the agent *what's missing*. Together they let the
 * agent walk the user through the flow conversationally without
 * any extra mutation surface.
 *
 * Critical guardrails baked into every hint:
 *
 *   - "ask one focused question at a time" — the coach must not
 *     barrage. One question, wait for an answer, advance.
 *   - "if the user steers in a different direction, follow them"
 *     — the hint is guidance, not a script. A user who wants to
 *     ramble about implementation details should be heard out.
 *   - Verbs the user owns ("approve_flow", "approve_architecture")
 *     are PROPOSED conversationally; the hint never tells the
 *     agent to fire them on the user's behalf. This mirrors the
 *     existing system prompt.
 *
 * The hint is regenerated from disk every turn, so a project that
 * just added a feature inside the same chat session will see the
 * coach update automatically the next turn.
 */

export type ChatScope = { kind: "global" } | { kind: "project"; slug: string };

/**
 * Compute the coach hint for the current scope. Returns a fenced
 * directive block ready to be appended to the prompt, or `null`
 * when there's no useful guidance to offer (caller should skip
 * the section entirely so we don't emit empty headers).
 */
export async function computeCoachHint(scope: ChatScope): Promise<string | null> {
  if (scope.kind === "global") {
    return computeGlobalHint();
  }
  return computeProjectHint(scope.slug);
}

const HEADER = [
  "[icarus coach — what to ask the user next]",
  "",
  "You are a guided coach. Walk the user through icarus's flow",
  "conversationally — they may not know where to start, what to ask",
  "for, or which step comes next. Your job is to make the system",
  "feel like a back-and-forth: one focused question at a time, wait",
  "for an answer, advance.",
  "",
  "GOLDEN RULE: if the user steers in a different direction, follow",
  "them. The hint below is guidance, not a script. A user who wants",
  "to chat about implementation details, ask a question, or jump",
  "around the flow should be heard out — don't badger them back to",
  "the next step.",
  "",
  "Phase 18 — the COUNCIL is the system's decider. When the user",
  "is happy with a flow / arch / task list, you `request_*_review`",
  "(or `request_task_planning`) and the council's chair verdict",
  "auto-fires the matching approve_* mutation. You DO NOT need to",
  "tell the user 'click Approve' — that's a legacy phrasing. Tell",
  "them 'I'll send this to the council' and let it decide. The",
  "user can manually `unapprove_*` or override later if they",
  "disagree, but the default path is council-driven.",
  "",
].join("\n");

async function computeGlobalHint(): Promise<string> {
  const fleet = await readFleet();
  const active = fleet.projects.filter((p) => p.status !== "archived");

  const lines: string[] = [HEADER];

  if (active.length === 0) {
    lines.push("STATE: this is the global chat. The user has no projects yet.");
    lines.push("");
    lines.push("ASK: what does the user want to build? Get a name and a one-");
    lines.push("line description, then emit `create_project` with both.");
    lines.push("After creating, propose taking them into the project chat:");
    lines.push("emit a `navigate { kind: \"project\", project_slug: <new>, tab: \"chat\" }`");
    lines.push("alongside a friendly \"let's start fleshing it out\" line.");
    return lines.join("\n");
  }

  const sample = active.slice(0, 6).map((p) => `${p.name} (${p.slug})`).join(", ");
  const more = active.length > 6 ? ` (+${active.length - 6} more)` : "";
  lines.push(
    `STATE: global chat. ${active.length} active project(s): ${sample}${more}.`,
  );
  lines.push("");
  lines.push(
    "ASK: do they want to start something new, or pick up an existing project?",
  );
  lines.push(
    "If they pick an existing one: emit `navigate { kind: \"project\", project_slug }`.",
  );
  lines.push(
    "If they want to start new: get a name + description, then `create_project`",
  );
  lines.push("and `navigate` them into the new project's chat.");
  lines.push("");
  lines.push("If the user is genuinely just chatting (not naming a project, not");
  lines.push("picking one), let the conversation breathe — don't force the choice.");
  return lines.join("\n");
}

async function computeProjectHint(slug: string): Promise<string | null> {
  const fleet = await readFleet();
  const project = fleet.projects.find((p) => p.slug === slug);
  if (!project) return null;

  const [features, flows, tasks, architecture] = await Promise.all([
    readFeatures(slug),
    readFlows(slug),
    readTasks(slug),
    readArchitecture(slug),
  ]);

  const active = features.filter((f) => f.status !== "archived");
  const draftFeatures = active.filter((f) => f.status === "draft");
  const flowingFeatures = active.filter((f) => f.status === "flowing");
  const flowReviewFeatures = active.filter((f) => f.status === "flow_review");
  const flowApprovedFeatures = active.filter((f) => f.status === "flow_approved");
  const planningFeatures = active.filter((f) => f.status === "planning");
  const plannedFeatures = active.filter(
    (f) => f.status === "planned" || f.status === "in_progress",
  );

  const archHasServices = architecture.services.length > 0;
  const archApproved = !!architecture.approved_at;

  const lines: string[] = [HEADER];

  // ---- Stage 1: no features yet ----
  if (active.length === 0) {
    lines.push(`STATE: project "${project.name}" has no features yet.`);
    lines.push("");
    lines.push("ASK: what's the first feature they want to build?");
    lines.push("Get a name + a one-line description, then emit `add_feature`.");
    lines.push("After it lands (you'll see the new feature_id in next turn's");
    lines.push("memory block), propose: \"want to walk through the user");
    lines.push("flow for this?\" and start drafting flow nodes when they say yes.");
    return lines.join("\n");
  }

  // ---- Stage 2: feature in draft, no flow drawn ----
  if (draftFeatures.length > 0) {
    const f = draftFeatures[0];
    const flow = flows.find((fl) => fl.feature_id === f.id);
    const nodeCount = flow?.nodes.length ?? 0;
    const edgeCount = flow?.edges.length ?? 0;

    if (nodeCount === 0) {
      lines.push(
        `STATE: feature "${f.name}" (id=${f.id}) is draft. No flow drawn yet.`,
      );
      lines.push("");
      lines.push(
        `ASK: walk me through the user journey for "${f.name}". What's the`,
      );
      lines.push("first thing the user does? What happens next?");
      lines.push("");
      lines.push("As they describe it, emit `add_flow_node` for each step AND");
      lines.push(
        "`add_flow_edge` to wire them together (use *_node_label endpoints",
      );
      lines.push("when you create the nodes in the same turn — server resolves them).");
      lines.push("Aim for 3–7 nodes per flow; ask one or two clarifying");
      lines.push("questions if the journey feels too sparse or too sprawling.");
      lines.push("");
      lines.push(
        "When the user says the flow looks complete, propose `request_flow_review`",
      );
      lines.push(
        "(\"send this to the council?\") — emit it after they confirm, NOT before.",
      );
      return lines.join("\n");
    }

    // Draft + partial flow → keep building
    lines.push(
      `STATE: feature "${f.name}" (id=${f.id}) has a partial flow (${nodeCount} nodes, ${edgeCount} edges).`,
    );
    lines.push("");
    lines.push("ASK: anything missing from the flow? Edge cases? Error paths?");
    lines.push("Add nodes/edges as the user describes them.");
    lines.push("");
    lines.push(
      'When the user says they\'re done, propose `request_flow_review` ("ready',
    );
    lines.push("to send this to the council?\"). Emit only after they confirm.");
    return lines.join("\n");
  }

  // ---- Stage 3: flowing (flow exists, ready for review) ----
  if (flowingFeatures.length > 0) {
    const f = flowingFeatures[0];
    lines.push(
      `STATE: feature "${f.name}" (id=${f.id}) has a flow drafted but no review run yet.`,
    );
    lines.push("");
    lines.push(
      'PROPOSE: "want me to send the flow to the council for review?"',
    );
    lines.push("If yes, emit `request_flow_review`.");
    lines.push("If they want to refine first, ask what they want to change.");
    return lines.join("\n");
  }

  // ---- Stage 4: flow_review (council running or done) ----
  if (flowReviewFeatures.length > 0) {
    const f = flowReviewFeatures[0];
    lines.push(`STATE: feature "${f.name}" (id=${f.id}) is in council review.`);
    lines.push("");
    lines.push(
      "STATUS: the council is running (or just finished). The chair's",
    );
    lines.push(
      "verdict will auto-fire `approve_flow` (on approve / approve_with_notes)",
    );
    lines.push(
      "or leave it in `flow_review` (on request_changes). Surface the verdict",
    );
    lines.push("conversationally when it lands; the Council panel has the full report.");
    lines.push("");
    lines.push(
      "If the user wants to override (e.g. council approved but user wants",
    );
    lines.push(
      "changes), they emit `request_flow_changes`. Don't pre-empt — let the",
    );
    lines.push("council decide first.");
    return lines.join("\n");
  }

  // ---- Stage 5: flow_approved + arch empty → ask architecture ----
  if (flowApprovedFeatures.length > 0 && !archHasServices) {
    const f = flowApprovedFeatures[0];
    lines.push(
      `STATE: "${f.name}" flow is approved. Architecture is empty (task planning is BLOCKED).`,
    );
    lines.push("");
    lines.push(
      "ASK: what services / datastores / external integrations does this need?",
    );
    lines.push("Get a quick list (2–6 services is typical for a single feature).");
    lines.push("");
    lines.push(
      "As the user names them, emit `add_service` (kinds: service / datastore /",
    );
    lines.push(
      "queue / external / client / infra) and `add_arch_edge` to wire them",
    );
    lines.push("(*_service_name endpoints when you create them in the same turn).");
    lines.push("");
    lines.push(
      'When the architecture looks complete, PROPOSE: "want me to send the arch',
    );
    lines.push(
      'to the council for review?" If yes, emit `request_arch_review` — the',
    );
    lines.push("council's chair verdict auto-approves the architecture if it passes.");
    return lines.join("\n");
  }

  // ---- Stage 6: arch drafted, not approved ----
  if (archHasServices && !archApproved) {
    lines.push(
      `STATE: architecture has ${architecture.services.length} services + ${architecture.edges.length} edges, NOT yet approved (task planning is BLOCKED).`,
    );
    lines.push("");
    lines.push(
      'PROPOSE: "want me to send the architecture to the council for review?"',
    );
    lines.push(
      "If yes, emit `request_arch_review` — the council auto-approves on chair",
    );
    lines.push(
      "approve / approve_with_notes. If they want to revise the arch first,",
    );
    lines.push("ask what to change and emit add/update/remove service+edge verbs.");
    return lines.join("\n");
  }

  // ---- Stage 7: flow_approved + arch_approved → propose task planning ----
  if (flowApprovedFeatures.length > 0 && archApproved) {
    const f = flowApprovedFeatures[0];
    lines.push(
      `STATE: "${f.name}" flow + architecture approved. Ready for task planning.`,
    );
    lines.push("");
    lines.push(
      `PROPOSE: "want me to plan the tasks for ${f.name}?" If yes, emit`,
    );
    lines.push(
      "`request_task_planning`. The council generates proposals AND auto-",
    );
    lines.push(
      "approves them on chair `approve`, so they land directly as real",
    );
    lines.push("tasks (not as proposals waiting for the user to click).");
    return lines.join("\n");
  }

  // ---- Stage 8: planning (council generating tasks) ----
  if (planningFeatures.length > 0) {
    const f = planningFeatures[0];
    lines.push(`STATE: "${f.name}" is in the task-planning council run.`);
    lines.push("");
    lines.push(
      "STATUS: planning run is in flight. On chair `approve` / `approve_with_notes`",
    );
    lines.push(
      "the runner auto-fires `approve_tasks` for ALL proposed tasks; they",
    );
    lines.push(
      "land on the Tasks tab as real `todo` rows ready for the queue. On",
    );
    lines.push(
      "`request_changes` the proposals are dropped and the user reverts to",
    );
    lines.push("`flow_approved` state.");
    lines.push("");
    lines.push(
      "PROPOSE: surface the verdict when it lands; offer to start the queue",
    );
    lines.push("(`start_queue`) once tasks are real.");
    return lines.join("\n");
  }

  // ---- Stage 9: planned (tasks exist, ready to run) ----
  if (plannedFeatures.length > 0) {
    const todoTasks = tasks.filter((t) => t.status === "todo" && !t.proposed);
    const inProgress = tasks.filter((t) => t.status === "in_progress");
    lines.push(
      `STATE: ${plannedFeatures.length} feature(s) planned. ${todoTasks.length} ready to run, ${inProgress.length} in flight.`,
    );
    lines.push("");
    if (todoTasks.length === 0 && inProgress.length === 0) {
      lines.push(
        "All tasks are done or stale. Ask the user what they want to tackle",
      );
      lines.push("next — a new feature, a refactor, anything.");
    } else if (inProgress.length > 0) {
      lines.push(
        'STATUS: queue is running. PROPOSE: "want me to surface the in-flight',
      );
      lines.push('tasks?" or just answer status questions about them.');
    } else {
      lines.push(
        'PROPOSE: "want me to start the queue?" If yes, emit `start_queue`',
      );
      lines.push(
        "(with `project_slug` for project-scoped, omit for fleet-wide).",
      );
      lines.push(
        "Or, if they want to run a specific task NOW, emit `start_task`.",
      );
    }
    return lines.join("\n");
  }

  // ---- Fallthrough: free-form mode ----
  // Project has features but none in any of the named lifecycle states
  // we'd nudge from. Likely all features are `done` or in odd combos.
  // Don't push a specific question — just hold space for the user.
  lines.push(
    `STATE: project "${project.name}" has ${active.length} feature(s) in mixed states; no obvious next step.`,
  );
  lines.push("");
  lines.push(
    "Just hold the conversation — answer what the user asks, propose the",
  );
  lines.push(
    "next thing they'd want IF you can read it from the chat history, but",
  );
  lines.push("don't force a coaching question if there's no clean one to ask.");
  return lines.join("\n");
}
