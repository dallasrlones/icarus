import type { Architecture, Feature, Flow, Task } from "../domain.js";
import type { ResolvedPersona } from "../personas/registry.js";

/**
 * Council prompts.
 *
 * Phase 14: prompts are now driven by a *resolved persona list* — the
 * runner asks `resolveCouncilPersonas(project_slug)` for the lenses
 * to run, and we render each lens prompt from `persona.name` +
 * `persona.prompt_template` (the persona's charter). Default lenses
 * still ship as `DEFAULT_PERSONAS` in the persona registry, so
 * behavior is unchanged when no custom personas are defined.
 *
 * Each prompt remains self-contained — no system-prompt mutation, no
 * chat memory, no project-context preamble. Council runs are
 * stateless and reproducible from the artifact on disk.
 */

interface FlowReviewInput {
  feature: Feature;
  flow: Flow | null;
}

/**
 * Single-lens flow review prompt.
 *
 * Phase 14: takes a resolved persona instead of a hardcoded lens id.
 * The persona's `key` is what gets emitted as `"lens"` in the JSON
 * envelope and stored on the resulting CouncilRun artifact. The
 * persona's `name` is used in the prose framing; its `prompt_template`
 * is injected as the lens charter.
 */
export function buildFlowReviewLensPrompt(
  persona: ResolvedPersona,
  input: FlowReviewInput,
  panelSize: number,
): string {
  const { feature, flow } = input;
  const flowText = flow ? formatFlow(flow) : "(no flow nodes drafted yet — call this out as blocking.)";
  return [
    `[icarus council — flow review · lens=${persona.key}]`,
    "",
    `You are the ${persona.name} lens of a ${panelSize}-lens review panel evaluating a feature's flow`,
    "before engineering commits to building it. You speak ONLY for your lens — the Chair",
    "synthesizes all lenses afterwards.",
    "",
    `Your charter: ${persona.prompt_template}`,
    "",
    "## Feature",
    `name: ${feature.name}`,
    feature.description ? `description: ${feature.description}` : `description: (none)`,
    `status: ${feature.status}`,
    "",
    "## Flow",
    flowText,
    "",
    "## Output contract",
    "Reply with EXACTLY ONE fenced JSON block, no prose before or after, containing only",
    "your lens's report.",
    "",
    "```json",
    "{",
    `  "lens": "${persona.key}",`,
    "  \"verdict\": \"approve\" | \"approve_with_notes\" | \"request_changes\",",
    "  \"reasoning\": \"<2-4 sentences>\",",
    "  \"findings\": [",
    "    {",
    "      \"severity\": \"info\" | \"minor\" | \"major\" | \"blocking\",",
    "      \"summary\": \"<one sentence>\",",
    "      \"must_address\": true | false,",
    "      \"node_id\": \"<optional, references a node from the flow above>\",",
    "      \"edge_id\": \"<optional, references an edge>\"",
    "    }",
    "  ],",
    "  \"questions\": [\"<optional list of clarifying questions for the user>\"]",
    "}",
    "```",
    "",
    "Rules:",
    "  - Be honest. Real critique, not a rubber stamp.",
    "  - `findings` may be an empty array. `questions` may be omitted.",
    "  - Stay strictly within your lens's charter — other lenses cover other ground.",
    "  - Do not include any text outside the fenced JSON block.",
  ].join("\n");
}

/**
 * Chair synthesis prompt for flow_review.
 *
 * Receives the five lens reports verbatim and returns ONLY the chair entry.
 */
export function buildFlowReviewChairPrompt(
  input: FlowReviewInput,
  lenses: Array<{ lens: string; verdict: string; reasoning: string; findings: { severity: string; summary: string; must_address?: boolean }[]; questions?: string[] }>,
): string {
  const { feature } = input;
  const lensSummaries = lenses
    .map((l) => {
      const findingLines = l.findings
        .map((f) => `      - [${f.severity}${f.must_address ? "·must_address" : ""}] ${f.summary}`)
        .join("\n");
      const questionLines = (l.questions ?? []).map((q) => `      ? ${q}`).join("\n");
      return [
        `  ${l.lens}: ${l.verdict}`,
        `    reasoning: ${l.reasoning}`,
        l.findings.length ? `    findings:\n${findingLines}` : "    findings: (none)",
        questionLines ? `    questions:\n${questionLines}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
  return [
    "[icarus council — flow review · chair synthesis]",
    "",
    `You are the Chair of a ${lenses.length}-lens review panel. Each lens has reported. Your job`,
    "is to synthesize their findings into one verdict for the user.",
    "",
    "## Feature",
    `name: ${feature.name}`,
    feature.description ? `description: ${feature.description}` : "description: (none)",
    "",
    "## Lens reports",
    lensSummaries,
    "",
    "## Output contract",
    "Reply with EXACTLY ONE fenced JSON block, no prose before or after.",
    "",
    "```json",
    "{",
    "  \"overall_verdict\": \"approve\" | \"approve_with_notes\" | \"request_changes\",",
    "  \"recommendation\": \"<2-4 sentences synthesizing the lenses>\",",
    "  \"top_concerns\": [\"<optional, 1-3 items the user should resolve before approving>\"],",
    "  \"must_address_count\": <integer = total findings across all lenses with must_address=true>",
    "}",
    "```",
    "",
    "Rules:",
    "  - Reflect the lenses' actual verdicts. If any lens said `request_changes` with",
    "    `must_address` findings, the chair should NOT approve outright.",
    "  - The Chair NEVER auto-approves on the user's behalf — the user reads your output and",
    "    presses Approve.",
    "  - Do not include any text outside the fenced JSON block.",
  ].join("\n");
}

interface TaskPlanningInput {
  feature: Feature;
  flow: Flow | null;
  /** Existing tasks in the project, for context (so the council doesn't dup). */
  existingTasks: Pick<Task, "id" | "title" | "feature_id" | "status">[];
}

export function buildTaskPlanningPrompt(input: TaskPlanningInput): string {
  const { feature, flow, existingTasks } = input;
  const flowText = flow ? formatFlow(flow) : "(no flow — abort with request_changes.)";

  const tasksText =
    existingTasks.length === 0
      ? "(none)"
      : existingTasks
          .slice(0, 30)
          .map(
            (t) =>
              `  - id=${t.id} title="${t.title}" feature=${t.feature_id ?? "(ad-hoc)"} status=${t.status}`,
          )
          .join("\n");

  return [
    "[icarus council — task planning]",
    "",
    "You are the Council planning the engineering tasks for an APPROVED feature flow.",
    "The user has already approved the flow itself; your job now is to break the flow",
    "into a focused list of implementation tasks that an autonomous agent could pick up",
    "and complete. The user will review and approve before any of these become real.",
    "",
    "## Feature",
    `name: ${feature.name}`,
    feature.description ? `description: ${feature.description}` : `description: (none)`,
    `status: ${feature.status}`,
    "",
    "## Approved flow",
    flowText,
    "",
    "## Existing tasks in this project (avoid duplicating)",
    tasksText,
    "",
    "## Output contract",
    "Reply with EXACTLY ONE fenced JSON block, no prose before or after. Use this fence:",
    "",
    "```json",
    "{",
    "  \"proposed_tasks\": [",
    "    {",
    "      \"title\": \"<imperative, ~80 chars max>\",",
    "      \"description\": \"<2-5 sentences of acceptance criteria>\",",
    "      \"priority\": <integer; higher = sooner; default 0>,",
    "      \"rationale\": \"<why this task; reference the flow if useful>\",",
    "      \"source_node_ids\": [\"<optional flow-node ids this task implements>\"]",
    "    }",
    "    /* repeat for each proposed task */",
    "  ],",
    "  \"notes\": \"<optional cross-task notes: dependencies, risks, ordering hints>\",",
    "  \"chair\": {",
    "    \"overall_verdict\": \"approve\" | \"approve_with_notes\" | \"request_changes\",",
    "    \"recommendation\": \"<2-4 sentences>\",",
    "    \"top_concerns\": [\"<optional 1-3 items>\"],",
    "    \"must_address_count\": <integer; usually 0 for task plans, non-zero only if you couldn't plan something safely>",
    "  }",
    "}",
    "```",
    "",
    "Rules:",
    "  - Tasks should be small enough that one autonomous run can finish each. Aim for 4-12 tasks.",
    "  - Order them by intended sequence; use `priority` to express ordering.",
    "  - Don't propose tasks for steps already covered by an existing task in the project.",
    "  - If the flow is too thin to plan safely, set chair verdict to \"request_changes\" and",
    "    leave `proposed_tasks` empty — the user will know to flesh out the flow first.",
    "  - Do not include any text outside the fenced JSON block.",
  ].join("\n");
}

// ---- Architecture review (Phase 18) ----

/**
 * Hardcoded arch-review lens charters. Unlike flow_review, the
 * arch panel is NOT user-customizable in v1 — the five concerns
 * below are universal to "is this a sound system architecture?"
 * and don't benefit from the per-project persona overrides that
 * flow_review uses for product/marketing/legal-style perspectives.
 *
 * Custom arch personas are a backlog item. Add them by extending
 * the persona registry's resolver to dispatch on review kind.
 */
export interface ArchLensSpec {
  key: string;
  name: string;
  charter: string;
}

export const ARCH_LENSES: readonly ArchLensSpec[] = [
  {
    key: "reliability",
    name: "Reliability",
    charter:
      "Will this design stay up under load, partial failure, and network partition? Look for single points of failure, missing retries / timeouts / circuit breakers, hidden synchronous dependencies on flaky third-parties, and any service that can take the whole system down when it falls over.",
  },
  {
    key: "scalability",
    name: "Scalability",
    charter:
      "Where does this break at 10x and 100x traffic? Identify bottlenecks (single-instance services, unsharded datastores, sync chains that grow O(n)), and call out anything that won't horizontally scale without redesign. Be specific about which component is the choke point.",
  },
  {
    key: "security",
    name: "Security",
    charter:
      "Is the trust boundary sound? Audit external touchpoints, authentication, authorization, secret handling, blast radius if any one service is compromised. Call out missing encryption at rest / in transit, services that talk to externals without an isolation layer, and components that hold credentials they shouldn't.",
  },
  {
    key: "cost",
    name: "Cost",
    charter:
      "Is this design going to surprise the user with a bill? Highlight expensive components (managed datastores, hot queues, external API call patterns), redundant services that could be consolidated, and any architecture that's inefficient by design (e.g. polling where webhooks would do, sync calls where events would do).",
  },
  {
    key: "operability",
    name: "Operability",
    charter:
      "Can a small team actually run this? Look for missing observability seams (no clear logs/metrics surface, no health checks), services with unclear ownership, deployment coupling that forces lock-step releases, and components that need bespoke runbooks the team doesn't have.",
  },
];

interface ArchReviewInput {
  architecture: Architecture;
  /** All flow_approved features at review time, for grounding context. */
  approvedFeatures: { id: string; name: string; description?: string }[];
}

export function buildArchReviewLensPrompt(
  lens: ArchLensSpec,
  input: ArchReviewInput,
  panelSize: number,
): string {
  const archText = formatArchitecture(input.architecture);
  const featuresText =
    input.approvedFeatures.length === 0
      ? "(no flow-approved features yet — call this out: arch review is most useful AFTER at least one feature flow has been approved.)"
      : input.approvedFeatures
          .slice(0, 12)
          .map((f) => `  - id=${f.id} name="${f.name}"${f.description ? ` — ${f.description}` : ""}`)
          .join("\n");
  return [
    `[icarus council — architecture review · lens=${lens.key}]`,
    "",
    `You are the ${lens.name} lens of a ${panelSize}-lens panel evaluating a system`,
    "architecture before engineering commits to building it. You speak ONLY for your lens —",
    "the Chair synthesizes all lenses afterwards.",
    "",
    `Your charter: ${lens.charter}`,
    "",
    "## Architecture under review",
    archText,
    "",
    "## Approved feature flows this architecture is meant to support",
    featuresText,
    "",
    "## Output contract",
    "Reply with EXACTLY ONE fenced JSON block, no prose before or after.",
    "",
    "```json",
    "{",
    `  "lens": "${lens.key}",`,
    "  \"verdict\": \"approve\" | \"approve_with_notes\" | \"request_changes\",",
    "  \"reasoning\": \"<2-4 sentences>\",",
    "  \"findings\": [",
    "    {",
    "      \"severity\": \"info\" | \"minor\" | \"major\" | \"blocking\",",
    "      \"summary\": \"<one sentence>\",",
    "      \"must_address\": true | false,",
    "      \"node_id\": \"<optional, references a service id from the architecture above>\",",
    "      \"edge_id\": \"<optional, references an arch edge id>\"",
    "    }",
    "  ],",
    "  \"questions\": [\"<optional list of clarifying questions for the user>\"]",
    "}",
    "```",
    "",
    "Rules:",
    "  - Be honest. Flag real risk, don't rubber-stamp.",
    "  - `findings` may be an empty array. `questions` may be omitted.",
    "  - Stay strictly within your lens — other lenses cover other ground.",
    "  - Use `node_id` to reference services, `edge_id` for arch edges (`node_id` is reused",
    "    instead of inventing a new field — same shape as flow review for storage parity).",
    "  - Do not include any text outside the fenced JSON block.",
  ].join("\n");
}

export function buildArchReviewChairPrompt(
  input: ArchReviewInput,
  lenses: Array<{ lens: string; verdict: string; reasoning: string; findings: { severity: string; summary: string; must_address?: boolean }[]; questions?: string[] }>,
): string {
  const lensSummaries = lenses
    .map((l) => {
      const findingLines = l.findings
        .map((f) => `      - [${f.severity}${f.must_address ? "·must_address" : ""}] ${f.summary}`)
        .join("\n");
      const questionLines = (l.questions ?? []).map((q) => `      ? ${q}`).join("\n");
      return [
        `  ${l.lens}: ${l.verdict}`,
        `    reasoning: ${l.reasoning}`,
        l.findings.length ? `    findings:\n${findingLines}` : "    findings: (none)",
        questionLines ? `    questions:\n${questionLines}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
  return [
    "[icarus council — architecture review · chair synthesis]",
    "",
    `You are the Chair of a ${lenses.length}-lens architecture review. Each lens has reported.`,
    "Your verdict drives icarus's `approve_architecture` gate automatically — `approve`",
    "or `approve_with_notes` will unlock task planning across the project; `request_changes`",
    "will leave the architecture un-approved and surface the concerns to the user.",
    "",
    `## Architecture summary`,
    `services: ${input.architecture.services.length}, edges: ${input.architecture.edges.length}`,
    "",
    "## Lens reports",
    lensSummaries,
    "",
    "## Output contract",
    "Reply with EXACTLY ONE fenced JSON block, no prose before or after.",
    "",
    "```json",
    "{",
    "  \"overall_verdict\": \"approve\" | \"approve_with_notes\" | \"request_changes\",",
    "  \"recommendation\": \"<2-4 sentences synthesizing the lenses>\",",
    "  \"top_concerns\": [\"<optional, 1-3 items the user should know about>\"],",
    "  \"must_address_count\": <integer = total findings across all lenses with must_address=true>",
    "}",
    "```",
    "",
    "Rules:",
    "  - Reflect the lenses' actual verdicts. If any lens said `request_changes` with",
    "    `must_address` findings, the chair should NOT approve outright.",
    "  - You are the system's decider here — be conservative when a lens raises a blocking",
    "    concern. The user can manually override via `unapprove_architecture` if they",
    "    disagree with you, but don't approve away real risk.",
    "  - Do not include any text outside the fenced JSON block.",
  ].join("\n");
}

function formatArchitecture(arch: Architecture): string {
  if (arch.services.length === 0) return "(no services drafted yet — chair should request_changes.)";
  const lines: string[] = [];
  lines.push(`services (${arch.services.length}):`);
  for (const s of arch.services) {
    const desc = s.description ? ` — ${s.description}` : "";
    lines.push(`  - id=${s.id} kind=${s.kind} name="${s.name}"${desc}`);
  }
  if (arch.edges.length === 0) {
    lines.push("edges: (none)");
  } else {
    lines.push(`edges (${arch.edges.length}):`);
    for (const e of arch.edges) {
      const lbl = e.label ? ` "${e.label}"` : "";
      const kind = e.kind ? ` [${e.kind}]` : "";
      lines.push(`  - id=${e.id} ${e.from_service_id} → ${e.to_service_id}${kind}${lbl}`);
    }
  }
  return lines.join("\n");
}

function formatFlow(flow: Flow): string {
  if (flow.nodes.length === 0) return "(empty flow.)";
  const lines: string[] = [];
  lines.push(`nodes (${flow.nodes.length}):`);
  for (const n of flow.nodes) {
    const desc = n.description ? ` — ${n.description}` : "";
    lines.push(`  - id=${n.id} kind=${n.kind ?? "step"} label="${n.label}"${desc}`);
  }
  if (flow.edges.length === 0) {
    lines.push("edges: (none)");
  } else {
    lines.push(`edges (${flow.edges.length}):`);
    for (const e of flow.edges) {
      const lbl = e.label ? ` "${e.label}"` : "";
      lines.push(`  - id=${e.id} ${e.from_node_id} → ${e.to_node_id}${lbl}`);
    }
  }
  return lines.join("\n");
}
