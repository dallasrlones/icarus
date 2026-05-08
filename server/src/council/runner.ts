import { z } from "zod";
import type { CursorOptions } from "../cursor.js";
import { runOneShot } from "../cursor.js";
import type { Feature, Flow, Task } from "../domain.js";
import { events } from "../events.js";
import { shortId } from "../ids.js";
import { projectLocks } from "../storage/locks.js";
import {
  readFeatures,
  readFlows,
  readTasks,
  writeFeatures,
  writeTasks,
} from "../storage/entities.js";
import {
  ARCH_LENSES,
  buildArchReviewChairPrompt,
  buildArchReviewLensPrompt,
  buildFlowReviewChairPrompt,
  buildFlowReviewLensPrompt,
  buildTaskPlanningPrompt,
  type ArchLensSpec,
} from "./prompts.js";
import { readArchitecture } from "../storage/entities.js";
import { modelFor } from "../storage/settings.js";
import { formatRulesBlock } from "../rules/inject.js";
import {
  resolveCouncilPersonas,
  type ResolvedPersona,
} from "../personas/registry.js";
import { saveRun } from "./storage.js";
import {
  type ArchReviewResult,
  type CouncilRun,
  type CouncilRunType,
  type FlowReviewResult,
  type ProposedTask,
  type TaskPlanningResult,
  type Verdict,
} from "./types.js";

/**
 * Council runner.
 *
 * Each request_* verb persists a `pending` CouncilRun and asks the runner
 * to fire-and-forget. The runner:
 *   1. Marks the run `running`, broadcasts an event.
 *   2. Builds the appropriate prompt from current project state.
 *   3. Invokes cursor-agent in one-shot mode (fresh, stateless chat).
 *   4. Extracts the fenced JSON envelope, validates with zod.
 *   5. On `task_planning`, materializes proposed tasks into tasks.json.
 *   6. Updates the run record (`completed` or `failed`), broadcasts the
 *      terminal event.
 *
 * Failures are sticky on the run record so the UI can show what happened.
 * The feature lifecycle does NOT auto-roll-back on failure — the user
 * decides whether to retry or take another path.
 */

export interface RunnerOptions {
  cursor: CursorOptions;
}

let runner: CouncilRunner | null = null;

export function getCouncilRunner(): CouncilRunner {
  if (!runner) throw new Error("council runner not initialized");
  return runner;
}

export function initCouncilRunner(opts: RunnerOptions): CouncilRunner {
  runner = new CouncilRunner(opts);
  return runner;
}

export class CouncilRunner {
  constructor(private readonly opts: RunnerOptions) {}

  /**
   * Fire a council run async. Returns immediately. The caller has already
   * persisted the `pending` run record and (for flow_review/task_planning)
   * applied any feature lifecycle transition.
   */
  fireAndForget(run: CouncilRun): void {
    // Surface a structured failure event but don't crash the server if the
    // run blows up — that's already a sticky `failed` artifact on disk.
    void this.execute(run).catch((err) => {
      console.error("[council] unhandled runner error:", err);
    });
  }

  private async execute(run: CouncilRun): Promise<void> {
    const { project_slug: slug, feature_id: featureId, type, id: runId } = run;

    // Phase A — mark running.
    const updated: CouncilRun = { ...run, status: "running" };
    await saveRun(updated);
    events.broadcast({
      type: "council_run_running",
      project_slug: slug,
      feature_id: featureId,
      run_id: runId,
      run_type: type,
      ts: Date.now(),
    });

    try {
      // Phase B — branch by run type. flow_review / task_planning are
      // feature-scoped and load the feature; architecture_review is
      // project-scoped (sentinel feature_id) and loads the architecture.
      //
      // Phase 20 — council is a system-decision path, not a user
      // chat. It runs on the "agent" model role (typically a heavier
      // reasoning model). Resolved per-run so a model flip in the UI
      // affects the *next* council run with no restart.
      const cursorOpts = {
        ...this.opts.cursor,
        model: await modelFor("agent", this.opts.cursor.model),
      };

      let parsed: FlowReviewResult | TaskPlanningResult | ArchReviewResult;
      let text = "";
      let durationMs: number | undefined;
      let feature: Feature | null = null;

      if (type === "architecture_review") {
        const fanout = await runArchReview(cursorOpts, slug);
        parsed = fanout.result;
        text = fanout.transcript;
        durationMs = fanout.durationMs;
      } else {
        const features = await readFeatures(slug);
        const found = features.find((f) => f.id === featureId);
        if (!found) throw new Error(`feature disappeared: ${featureId}`);
        feature = found;
        const flows = await readFlows(slug);
        const flow = flows.find((f) => f.feature_id === featureId) ?? null;

        if (type === "flow_review") {
          // Phase 9: 5-parallel lens runs + chair synthesis. The artifact
          // shape is identical to the v1 envelope, so storage/UI stay put.
          const fanout = await runFlowReviewParallel(cursorOpts, { feature: found, flow });
          parsed = fanout.result;
          text = fanout.transcript;
          durationMs = fanout.durationMs;
        } else {
          const tasks = await readTasks(slug);
          const rulesBlock = await formatRulesBlock({ kind: "project", slug });
          const prompt =
            rulesBlock +
            buildTaskPlanningPrompt({
              feature: found,
              flow,
              existingTasks: tasks.map((t) => ({
                id: t.id,
                title: t.title,
                feature_id: t.feature_id,
                status: t.status,
              })),
            });
          const single = await runWithRetry(cursorOpts, prompt, (out) =>
            parseEnvelope(out, type),
          );
          parsed = single.parsed;
          text = single.text;
          durationMs = single.durationMs;
        }
      }

      // Phase E — persist completion.
      let completed: CouncilRun = {
        ...updated,
        status: "completed",
        finished_at: Date.now(),
        result: parsed,
        raw_text: text,
      };

      // Phase F — for task_planning, materialize proposed tasks into tasks.json.
      if (type === "task_planning" && feature) {
        completed = await materializeProposedTasks(slug, feature, completed);
      }

      await saveRun(completed);

      events.broadcast({
        type: "council_run_completed",
        project_slug: slug,
        feature_id: featureId,
        run_id: runId,
        run_type: type,
        ts: Date.now(),
      });
      if (process.env.CURSOR_DEBUG) {
        console.error(`[council] ${type} run ${runId} completed in ${durationMs ?? "?"}ms`);
      }

      // Phase G — Phase 18 auto-decide. The council is the system's
      // decider for flow / task / architecture approval; on `approve`
      // or `approve_with_notes` we fire the corresponding mutation
      // automatically. `request_changes` is the council's "no" — we
      // leave the gate closed and the user can either iterate or
      // override manually.
      await autoAdvance(completed);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const failed: CouncilRun = {
        ...updated,
        status: "failed",
        finished_at: Date.now(),
        error: message,
      };
      await saveRun(failed);
      events.broadcast({
        type: "council_run_failed",
        project_slug: slug,
        feature_id: featureId,
        run_id: runId,
        run_type: type,
        error: message,
        ts: Date.now(),
      });
    }
  }
}

// ---- Run helpers ----

interface OneShotResult<T> {
  parsed: T;
  text: string;
  durationMs?: number;
}

/**
 * Run a single cursor-agent turn with one retry on parse/schema failure.
 * The retry quotes the validator error verbatim so the model can self-correct.
 */
async function runWithRetry<T>(
  opts: CursorOptions,
  prompt: string,
  parse: (text: string) => T,
): Promise<OneShotResult<T>> {
  const MAX_ATTEMPTS = 2;
  let attempts = 0;
  let lastErr = "";
  let text = "";
  let durationMs: number | undefined;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempts++;
    const turnPrompt =
      attempts === 1
        ? prompt
        : [
            "[icarus council retry]",
            "Your previous reply failed validation:",
            `  ${lastErr}`,
            "",
            "Re-emit the entire envelope, correcting the issue. Same fenced",
            "```json block, no prose before or after, all required fields present.",
            "Do NOT explain — emit only the JSON block.",
          ].join("\n");
    const out = await runOneShot(opts, turnPrompt);
    text = out.text;
    durationMs = out.durationMs ?? durationMs;
    try {
      const parsed = parse(text);
      return { parsed, text, durationMs };
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
      if (attempts >= MAX_ATTEMPTS) throw err;
      if (process.env.CURSOR_DEBUG) {
        console.error(`[council] parse retry: ${lastErr}`);
      }
    }
  }
}

/**
 * Phase 9/14 N-parallel flow review.
 *
 * Fans out one cursor-agent run per *resolved* lens (defaults +
 * customs from the persona registry). Each run produces exactly one
 * lens report. Once all N land we run a chair synthesis pass. Output
 * shape matches the v1 single-shot envelope so the rest of the
 * council pipeline (storage, UI, approve/reject verbs) is unchanged.
 *
 * Failure semantics:
 *   - If a lens fails after retry, the whole run fails (the user gets a
 *     sticky `failed` artifact and can re-request_flow_review).
 *   - The chair pass also has one retry. A chair failure fails the run.
 */
async function runFlowReviewParallel(
  opts: CursorOptions,
  input: { feature: Feature; flow: Flow | null },
): Promise<{ result: FlowReviewResult; transcript: string; durationMs?: number }> {
  const t0 = Date.now();
  // Phase 12: rules block prepended to every lens + chair run so user
  // guidance applies to the council too. Same scope (the feature's
  // project) for all lenses, computed once.
  const rulesBlock = await formatRulesBlock({
    kind: "project",
    slug: input.feature.project_slug,
  });
  // Phase 14: resolve the persona set ONCE up-front so all lens runs
  // see the same panel size + identical key list. Re-resolving per
  // lens would risk a custom persona being added mid-run and
  // confusing the parser.
  const personas = await resolveCouncilPersonas(input.feature.project_slug);
  if (personas.length === 0) {
    // Defensive: should be unreachable since DEFAULT_PERSONAS always
    // seeds at least 5. If a future change ever empties them, fail
    // loudly rather than running an empty council.
    throw new Error("council resolved zero personas; check the persona registry");
  }
  const lensRuns = await Promise.all(
    personas.map(async (persona) => {
      const prompt =
        rulesBlock + buildFlowReviewLensPrompt(persona, input, personas.length);
      const out = await runWithRetry(opts, prompt, (text) =>
        parseSingleLensEnvelope(text, persona),
      );
      return { persona, ...out };
    }),
  );
  const lenses = lensRuns.map((r) => r.parsed);

  const chairPrompt = rulesBlock + buildFlowReviewChairPrompt(input, lenses);
  const chairOut = await runWithRetry(opts, chairPrompt, (text) => parseChairEnvelope(text));

  const result: FlowReviewResult = {
    kind: "flow_review",
    lenses: lenses.map((l) => ({ ...l, findings: l.findings ?? [] })),
    chair: { ...chairOut.parsed, top_concerns: chairOut.parsed.top_concerns ?? [] },
  };

  const transcript = [
    ...lensRuns.map(
      (r) => `=== lens=${r.persona.key} (${r.durationMs ?? "?"}ms, ${r.persona.source}) ===\n${r.text}`,
    ),
    `=== chair (${chairOut.durationMs ?? "?"}ms) ===\n${chairOut.text}`,
  ].join("\n\n");

  return { result, transcript, durationMs: Date.now() - t0 };
}

/**
 * Phase 18 — N-parallel architecture review.
 *
 * Same shape as `runFlowReviewParallel` but lenses come from the
 * hardcoded `ARCH_LENSES` table (reliability, scalability,
 * security, cost, operability) rather than the per-project
 * persona registry. Custom arch personas are a backlog item;
 * for v1 the universal arch concerns are baked in.
 *
 * Architecture is project-scoped, so the input loads the project's
 * arch + the list of currently flow-approved features for grounding.
 */
async function runArchReview(
  opts: CursorOptions,
  slug: string,
): Promise<{ result: ArchReviewResult; transcript: string; durationMs?: number }> {
  const t0 = Date.now();
  const rulesBlock = await formatRulesBlock({ kind: "project", slug });

  const [arch, features] = await Promise.all([readArchitecture(slug), readFeatures(slug)]);
  if (arch.services.length === 0) {
    throw new Error("architecture has no services; nothing to review");
  }
  const approvedFeatures = features
    .filter(
      (f) =>
        f.status === "flow_approved" ||
        f.status === "planning" ||
        f.status === "planned" ||
        f.status === "in_progress",
    )
    .map((f) => ({ id: f.id, name: f.name, description: f.description }));

  const lenses: readonly ArchLensSpec[] = ARCH_LENSES;
  const lensRuns = await Promise.all(
    lenses.map(async (lens) => {
      const prompt =
        rulesBlock +
        buildArchReviewLensPrompt(lens, { architecture: arch, approvedFeatures }, lenses.length);
      const out = await runWithRetry(opts, prompt, (text) =>
        parseSingleArchLensEnvelope(text, lens),
      );
      return { lens, ...out };
    }),
  );
  const reports = lensRuns.map((r) => r.parsed);

  const chairPrompt =
    rulesBlock +
    buildArchReviewChairPrompt({ architecture: arch, approvedFeatures }, reports);
  const chairOut = await runWithRetry(opts, chairPrompt, (text) => parseChairEnvelope(text));

  const result: ArchReviewResult = {
    kind: "architecture_review",
    lenses: reports.map((l) => ({ ...l, findings: l.findings ?? [] })),
    chair: { ...chairOut.parsed, top_concerns: chairOut.parsed.top_concerns ?? [] },
  };

  const transcript = [
    ...lensRuns.map(
      (r) => `=== arch lens=${r.lens.key} (${r.durationMs ?? "?"}ms) ===\n${r.text}`,
    ),
    `=== chair (${chairOut.durationMs ?? "?"}ms) ===\n${chairOut.text}`,
  ].join("\n\n");

  return { result, transcript, durationMs: Date.now() - t0 };
}

/**
 * Phase 18 — auto-decide hook.
 *
 * After a council run completes, fire the corresponding approve
 * mutation automatically when the chair returns approve /
 * approve_with_notes. Failures here are logged but never crash
 * the runner — the run record is already on disk, the user can
 * see the verdict and approve manually if the auto-decide trips.
 *
 * `applyMutation` is loaded via dynamic import to avoid a static
 * cycle (mutations/applicators.ts imports `getCouncilRunner`).
 */
async function autoAdvance(run: CouncilRun): Promise<void> {
  if (run.status !== "completed" || !run.result) return;
  const verdict: Verdict = run.result.chair.overall_verdict;
  if (verdict === "request_changes") return;

  let envelope:
    | { kind: "approve_flow"; payload: { project_slug: string; feature_id: string; run_id: string } }
    | { kind: "approve_tasks"; payload: { project_slug: string; feature_id: string; task_ids: string[] } }
    | { kind: "approve_architecture"; payload: { project_slug: string } }
    | null = null;

  if (run.type === "flow_review") {
    envelope = {
      kind: "approve_flow",
      payload: {
        project_slug: run.project_slug,
        feature_id: run.feature_id,
        run_id: run.id,
      },
    };
  } else if (run.type === "task_planning" && run.result.kind === "task_planning") {
    const taskIds = run.result.proposed_tasks.map((t) => t.id);
    if (taskIds.length === 0) return; // nothing to approve
    envelope = {
      kind: "approve_tasks",
      payload: {
        project_slug: run.project_slug,
        feature_id: run.feature_id,
        task_ids: taskIds,
      },
    };
  } else if (run.type === "architecture_review") {
    envelope = {
      kind: "approve_architecture",
      payload: { project_slug: run.project_slug },
    };
  }

  if (!envelope) return;

  try {
    const { applyMutation } = await import("../mutations/apply.js");
    const result = await applyMutation(envelope, { workspaceRoot: process.env.WORKSPACE_ROOT ?? process.cwd() });
    if (result.ok) {
      events.broadcast({
        type: "council_auto_decided",
        project_slug: run.project_slug,
        feature_id: run.feature_id,
        run_id: run.id,
        run_type: run.type,
        verdict,
        applied: envelope.kind,
        ts: Date.now(),
      });
      if (process.env.CURSOR_DEBUG) {
        console.error(
          `[council] auto-decide: ${run.type} verdict=${verdict} → ${envelope.kind} OK`,
        );
      }
    } else {
      console.error(
        `[council] auto-decide skipped: ${envelope.kind} returned ${result.status} ${result.error}`,
      );
    }
  } catch (err) {
    console.error("[council] auto-decide threw:", err);
  }
}

// ---- JSON extraction ----

// Models occasionally emit `null` for "not applicable" optional fields
// rather than omitting them, so every optional field below is nullish.
// Empty-string is also coerced to undefined to handle "" instead of null.
const optStr = z.preprocess(
  (v) => (v === null || v === "" ? undefined : v),
  z.string().optional(),
);
const optNum = z.preprocess(
  (v) => (v === null || v === "" ? undefined : v),
  z.number().int().optional(),
);
const optStrArr = z.preprocess(
  (v) => (v === null ? undefined : v),
  z.array(z.string()).optional(),
);
const optBool = z.preprocess(
  (v) => (v === null ? undefined : v),
  z.boolean().optional(),
);

const TaskPlanningSchema = z.object({
  proposed_tasks: z
    .array(
      z.object({
        title: z.string().min(1),
        description: optStr,
        priority: optNum,
        rationale: optStr,
        source_node_ids: optStrArr,
      }),
    )
    .default([]),
  notes: optStr,
  chair: z.object({
    overall_verdict: z.enum(["approve", "approve_with_notes", "request_changes"]),
    recommendation: z.string(),
    top_concerns: optStrArr,
    must_address_count: z.number().int().nonnegative(),
  }),
});

// Phase 14: `lens` is now a free-form string (any persona key,
// including custom ones). We validate that the value matches the
// expected key for the run in `parseSingleLensEnvelope` rather than
// constraining at the schema layer.
const SingleLensSchema = z.object({
  lens: z.string().min(1),
  verdict: z.enum(["approve", "approve_with_notes", "request_changes"]),
  reasoning: z.string(),
  findings: z
    .array(
      z.object({
        severity: z.enum(["info", "minor", "major", "blocking"]),
        summary: z.string(),
        must_address: optBool,
        node_id: optStr,
        edge_id: optStr,
      }),
    )
    .default([]),
  questions: optStrArr,
});

const ChairSchema = z.object({
  overall_verdict: z.enum(["approve", "approve_with_notes", "request_changes"]),
  recommendation: z.string(),
  top_concerns: optStrArr,
  must_address_count: z.number().int().nonnegative(),
});

type SingleLensReport = z.infer<typeof SingleLensSchema>;
type ChairReport = z.infer<typeof ChairSchema>;

function parseSingleLensEnvelope(
  text: string,
  expected: ResolvedPersona,
): SingleLensReport {
  return parseLensEnvelopeForKey(text, expected.key);
}

function parseSingleArchLensEnvelope(
  text: string,
  expected: ArchLensSpec,
): SingleLensReport {
  return parseLensEnvelopeForKey(text, expected.key);
}

function parseLensEnvelopeForKey(text: string, key: string): SingleLensReport {
  const json = extractJsonBlock(text);
  if (!json) throw new Error(`no JSON envelope in lens=${key} reply`);
  const raw = robustParseJson(json);
  const parsed = SingleLensSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`schema mismatch (lens=${key}): ${formatZod(parsed.error)}`);
  }
  if (parsed.data.lens !== key) {
    throw new Error(`lens mismatch: expected ${key}, got ${parsed.data.lens}`);
  }
  return parsed.data;
}

function parseChairEnvelope(text: string): ChairReport {
  const json = extractJsonBlock(text);
  if (!json) throw new Error("no JSON envelope in chair reply");
  const raw = robustParseJson(json);
  const parsed = ChairSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`schema mismatch (chair): ${formatZod(parsed.error)}`);
  return parsed.data;
}

/**
 * Parse a JSON string, falling back to escaping unescaped control chars
 * inside string literals if the strict parse fails. Models occasionally
 * emit raw newlines/tabs in `"reasoning"` fields and similar.
 */
function robustParseJson(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch (firstErr) {
    try {
      return JSON.parse(escapeControlCharsInsideStrings(json));
    } catch (secondErr) {
      const msg = secondErr instanceof Error ? secondErr.message : secondErr;
      throw new Error(
        `JSON parse failed: ${msg}; first 200 chars: ${json.slice(0, 200).replace(/\n/g, " ")}`,
      );
    }
  }
}

// `parseEnvelope` is only called for `task_planning` since flow
// reviews go through the per-lens parallel path. `_type` is kept on
// the signature for forward-compat in case future run types want to
// reuse this scaffolding.
function parseEnvelope(
  text: string,
  _type: CouncilRunType,
): TaskPlanningResult {
  const json = extractJsonBlock(text);
  if (!json) throw new Error("no JSON envelope in council reply");
  const raw = robustParseJson(json);

  const parsed = TaskPlanningSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`schema mismatch: ${formatZod(parsed.error)}`);
  return {
    kind: "task_planning",
    proposed_tasks: parsed.data.proposed_tasks.map((t) => ({
      id: shortId("task"),
      ...t,
    })),
    notes: parsed.data.notes,
    chair: { ...parsed.data.chair, top_concerns: parsed.data.chair.top_concerns ?? [] },
  };
}

/**
 * Extract the first fenced ```json block. Falls back to the first standalone
 * top-level `{ ... }` substring if the model forgot the fence.
 */
function extractJsonBlock(text: string): string | null {
  const fence = /```(?:json)?\s*\n([\s\S]*?)\n```/m.exec(text);
  if (fence) return fence[1].trim();
  // Fallback: first balanced { ... } at top level.
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function formatZod(err: z.ZodError): string {
  return err.issues
    .map((iss) => `${iss.path.join(".") || "(root)"}: ${iss.message}`)
    .join("; ");
}

/**
 * Walk the JSON char-by-char, tracking whether we're inside a string,
 * and replace unescaped control characters inside strings with their
 * \uXXXX equivalent. Outside strings the characters pass through (so
 * newlines for indentation are preserved).
 *
 * This rescues the common LLM failure of emitting `"reasoning": "line one\n
 * line two"` as a literal multi-line string instead of using `\\n`.
 */
function escapeControlCharsInsideStrings(s: string): string {
  let out = "";
  let inString = false;
  let escape = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escape) {
      out += ch;
      escape = false;
      continue;
    }
    if (ch === "\\" && inString) {
      out += ch;
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      out += ch;
      continue;
    }
    if (inString) {
      const code = ch.charCodeAt(0);
      if (code < 0x20) {
        out += "\\u" + code.toString(16).padStart(4, "0");
        continue;
      }
    }
    out += ch;
  }
  return out;
}

// ---- Materialize proposed tasks into tasks.json ----

/**
 * On a successful task_planning run, push the proposed tasks into the
 * project's tasks.json with `proposed: true` and `feature_id` set. This
 * happens under the project lock so a concurrent click-ops add doesn't
 * race with us.
 *
 * Returns the council run with each proposed task stamped with the id we
 * actually used in tasks.json (so the approval verb later can flip the
 * right rows).
 */
async function materializeProposedTasks(
  slug: string,
  feature: Feature,
  run: CouncilRun,
): Promise<CouncilRun> {
  if (run.status !== "completed" || run.result?.kind !== "task_planning") return run;
  const planning = run.result;

  return await projectLocks.run(slug, async () => {
    const tasks = await readTasks(slug);
    const now = Date.now();
    const stamped: ProposedTask[] = [];

    for (const proposal of planning.proposed_tasks) {
      const task: Task = {
        id: proposal.id,
        project_slug: slug,
        feature_id: feature.id,
        title: proposal.title,
        description: proposal.description,
        status: "todo",
        priority: proposal.priority,
        proposed: true,
        created_at: now,
        updated_at: now,
      };
      tasks.unshift(task);
      stamped.push(proposal);
    }

    await writeTasks(slug, tasks);

    // Defensive: also re-read features in case status changed mid-run.
    // We're inside the project lock so it's a consistent snapshot.
    const features = await readFeatures(slug);
    const i = features.findIndex((f) => f.id === feature.id);
    if (i >= 0) {
      // Don't change feature status here — the verb already moved it to
      // `planning`; approval flips it to `planned`.
      features[i] = { ...features[i], updated_at: now };
      await writeFeatures(slug, features);
    }

    return {
      ...run,
      result: { ...planning, proposed_tasks: stamped },
    };
  });
}
