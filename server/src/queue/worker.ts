import type { ChildProcess } from "node:child_process";
import { FenceParser } from "../commands/parser.js";
import { buildTaskExecutionPrompt } from "../commands/system_prompt.js";
import * as cursor from "../cursor.js";
import type { CursorOptions } from "../cursor.js";
import { events } from "../events.js";
import { shortId } from "../ids.js";
import { applyMutation } from "../mutations/apply.js";
import type { ApplyContext } from "../mutations/applicators.js";
import { readFleet } from "../storage/fleet.js";
import { readFeatures, readFlows } from "../storage/entities.js";
import { modelFor } from "../storage/settings.js";
import { readTools } from "../storage/tools.js";
import { buildToolTaskPrompt } from "../tools/render.js";
import { formatRulesBlock } from "../rules/inject.js";
import type { Flow, Task } from "../domain.js";
import { listEligibleTasks, pickNext, type PickerCandidate } from "./picker.js";
import { saveTaskRun, type TaskRunRecord } from "./storage.js";
import type {
  QueueScope,
  QueueState,
  RunningTask,
  RunningTaskStatus,
} from "./types.js";

const OUTPUT_TAIL_CAP = 32_000; // bytes kept in the live UI snapshot
const EMPTY_QUEUE_GRACE_MS = 800;

const DEFAULT_PARALLELISM = (() => {
  const raw = process.env.ICARUS_QUEUE_PARALLELISM;
  if (!raw) return 2;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return 2;
  return Math.min(n, 8);
})();

/**
 * Multi-slot autonomous queue.
 *
 * State machine: idle → running ⇄ paused → idle (when explicitly stopped).
 * Up to `maxParallel` tasks run concurrently. Each running task takes an
 * in-memory lease (keyed by task_id and optional resource_scope); the
 * picker excludes leased ids/scopes so two workers never claim the same
 * task or step on each other's resources.
 *
 * Single-process: leases live in memory. On restart the queue boots
 * `idle` and abandoned in-progress tasks stay marked in_progress until
 * the user moves them. Heartbeats / crash recovery are explicitly out of
 * scope here — the lease is just a coordination primitive between the
 * in-memory workers.
 */
export class QueueWorker {
  private state: QueueState = {
    run: "idle",
    scope: {},
    changed_at: Date.now(),
  };
  /** workerSlot id → currently-running task (or null when the slot is free). */
  private slots: Array<RunningTask | null>;
  /** workerSlot id → child process handle, used for SIGTERM on stop(). */
  private slotChildren: Array<ChildProcess | null>;
  /** Active leases keyed by task id (all currently-running tasks). */
  private leases = new Map<string, { resource_scope?: string; started_at: number }>();
  /** Per-slot mutex flag — `true` while that slot is busy spawning/running. */
  private slotBusy: boolean[];
  private loopRunning = false;
  /** Coarse mutex around pickNext+lease acquire so two slots never grab the same task. */
  private pickerMutex = Promise.resolve();
  private readonly maxParallel: number;

  constructor(
    private readonly cursorOpts: CursorOptions,
    private readonly applyCtx: ApplyContext,
    opts?: { maxParallel?: number },
  ) {
    this.maxParallel = opts?.maxParallel ?? DEFAULT_PARALLELISM;
    this.slots = new Array(this.maxParallel).fill(null);
    this.slotChildren = new Array(this.maxParallel).fill(null);
    this.slotBusy = new Array(this.maxParallel).fill(false);
  }

  // ---- Public API -------------------------------------------------------

  snapshot(): { state: QueueState; current: RunningTask | null; running: RunningTask[] } {
    const running = this.slots.filter((s): s is RunningTask => s !== null).map((s) => ({ ...s }));
    return {
      state: this.state,
      current: running[0] ?? null,
      running,
    };
  }

  async listEligible(): Promise<PickerCandidate[]> {
    return await listEligibleTasks(this.state.scope, this.excludes());
  }

  start(scope: QueueScope): void {
    this.transition({ run: "running", scope, changed_at: Date.now(), note: undefined });
    this.kickLoop();
  }

  pause(note?: string): void {
    this.transition({
      run: "paused",
      scope: this.state.scope,
      changed_at: Date.now(),
      note,
    });
  }

  stop(note?: string): void {
    this.transition({
      run: "idle",
      scope: {},
      changed_at: Date.now(),
      note: note ?? "stopped",
    });
    // Tear down everything in flight.
    for (let i = 0; i < this.slotChildren.length; i++) {
      const child = this.slotChildren[i];
      if (child) child.kill("SIGTERM");
    }
  }

  /**
   * Manually run a single task, bypassing queue state. Returns when the
   * run finishes. Will wait for a free slot if all slots are busy.
   */
  async runOne(slug: string, taskId: string): Promise<void> {
    // Wait for a free slot.
    while (this.slotBusy.every((b) => b)) await sleep(150);
    const fleet = await readFleet();
    const project = fleet.projects.find((p) => p.slug === slug);
    if (!project) throw new Error(`unknown project: ${slug}`);
    const features = await readFeatures(slug);
    const tasks = await readTasksForRunOne(slug);
    const task = tasks.find((t) => t.id === taskId);
    if (!task) throw new Error(`unknown task: ${taskId}`);
    if (this.leases.has(task.id)) {
      throw new Error(`task ${taskId} is already running`);
    }
    const feature = task.feature_id ? features.find((f) => f.id === task.feature_id) ?? null : null;
    const slotIdx = this.slotBusy.findIndex((b) => !b);
    if (slotIdx < 0) throw new Error("no free slot (concurrent runOne race)");
    await this.runOnSlot(slotIdx, { task, feature });
  }

  // ---- Internals --------------------------------------------------------

  private transition(next: QueueState): void {
    this.state = next;
    events.broadcast({
      type: "queue_state_changed",
      run: next.run,
      project_slug: next.scope.project_slug,
      note: next.note,
      ts: Date.now(),
    });
  }

  private excludes(): { taskIds: Set<string>; scopes: Set<string> } {
    const taskIds = new Set<string>();
    const scopes = new Set<string>();
    for (const [id, lease] of this.leases) {
      taskIds.add(id);
      if (lease.resource_scope) scopes.add(lease.resource_scope);
    }
    return { taskIds, scopes };
  }

  private kickLoop(): void {
    if (this.loopRunning) return;
    this.loopRunning = true;
    void this.loop().finally(() => {
      this.loopRunning = false;
    });
  }

  /**
   * Main scheduler. Repeatedly fills any free slot with the next eligible
   * task. Exits when the queue drains (and there's nothing in flight) or
   * when state.run leaves "running".
   */
  private async loop(): Promise<void> {
    while (this.state.run === "running") {
      // Pick + dispatch any free slots in parallel.
      const dispatched = await this.dispatchFreeSlots();

      if (dispatched === 0 && this.leases.size === 0) {
        // No work picked AND nothing in flight → drained.
        this.transition({
          run: "idle",
          scope: this.state.scope,
          changed_at: Date.now(),
          note: "queue drained",
        });
        await sleep(EMPTY_QUEUE_GRACE_MS);
        return;
      }

      // Yield to let in-flight tasks make progress before we re-poll.
      await sleep(dispatched > 0 ? 50 : 250);
    }
  }

  /**
   * Try to fill every currently-free slot. Picker-mutex-serialized so
   * two slots can't race for the same task. Returns the number newly
   * dispatched (0 means the queue is empty given current excludes).
   */
  private async dispatchFreeSlots(): Promise<number> {
    return await this.runUnderPickerMutex(async () => {
      let dispatched = 0;
      for (let i = 0; i < this.maxParallel; i++) {
        if (this.slotBusy[i]) continue;
        if ((this.state.run as QueueRunStateLiteral) !== "running") break;

        const candidate = await pickNext(this.state.scope, this.excludes());
        if (!candidate) break; // nothing eligible right now
        this.acquireLease(candidate);
        // Fire and forget — runOnSlot resolves when the task ends.
        void this.runOnSlot(i, candidate).catch((err) => {
          console.error("[queue] slot crashed:", err);
        });
        dispatched++;
      }
      return dispatched;
    });
  }

  private async runUnderPickerMutex<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.pickerMutex;
    let release!: () => void;
    this.pickerMutex = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private acquireLease(candidate: PickerCandidate): void {
    this.leases.set(candidate.task.id, {
      resource_scope: candidate.task.resource_scope,
      started_at: Date.now(),
    });
  }

  private releaseLease(taskId: string): void {
    this.leases.delete(taskId);
  }

  /**
   * Execute one candidate inside a specific slot. The slot is marked busy
   * for the duration; the lease is released on completion. Designed to be
   * called fire-and-forget — the loop polls slotBusy / leases to know
   * when to schedule more.
   */
  private async runOnSlot(slotIdx: number, candidate: PickerCandidate): Promise<void> {
    this.slotBusy[slotIdx] = true;
    const slug = candidate.task.project_slug;
    const taskId = candidate.task.id;
    const runId = shortId("trun");

    // Lifecycle transition todo → in_progress.
    const startResult = await applyMutation(
      {
        kind: "update_task",
        payload: { project_slug: slug, task_id: taskId, status: "in_progress" },
      },
      this.applyCtx,
    );
    if (!startResult.ok) {
      console.error(`[queue] failed to mark task in_progress: ${startResult.error}`);
      this.releaseLease(taskId);
      this.slotBusy[slotIdx] = false;
      return;
    }

    const initialRunning: RunningTask = {
      task_id: taskId,
      project_slug: slug,
      title: candidate.task.title,
      started_at: Date.now(),
      status: "spawning",
      output_tail: "",
      pills: 0,
      retries: 0,
    };
    this.slots[slotIdx] = initialRunning;
    events.broadcast({
      type: "task_started",
      project_slug: slug,
      task_id: taskId,
      run_id: runId,
      title: candidate.task.title,
      ts: Date.now(),
    });

    const transcript: { raw: string; pills: TaskRunRecord["pills"] } = { raw: "", pills: [] };

    try {
      const prompt = await this.buildPrompt(candidate);
      const opts = await this.optsForProject(slug);

      const cursorChatId = await cursor.createChat(opts);
      this.patchSlot(slotIdx, { status: "running" });

      const parser = new FenceParser();
      const handleParserEvent = async (
        ev:
          | { type: "text"; text: string }
          | { type: "pill_open"; id: string }
          | { type: "pill_close"; id: string; body: string },
      ) => {
        if (ev.type === "text") {
          this.appendOutput(slotIdx, ev.text);
          transcript.raw += ev.text;
        } else if (ev.type === "pill_open") {
          // chat-style pills don't apply to queue runs
        } else {
          const closed = await this.applyTerminal(slug, ev.body);
          transcript.pills.push(closed);
          const slot = this.slots[slotIdx];
          this.patchSlot(slotIdx, { pills: (slot?.pills ?? 0) + 1 });
          if (closed.kind === "enqueue_question" && closed.result) {
            const r = closed.result as { question?: { id?: string } };
            if (r.question?.id) {
              this.patchSlot(slotIdx, {
                status: "awaiting_question",
                blocking_question_id: r.question.id,
              });
            }
          }
        }
      };

      let runError: string | null = null;
      for await (const event of cursor.sendTurn(opts, cursorChatId, prompt)) {
        switch (event.kind) {
          case "delta": {
            const ev = parser.feed(event.text);
            for (const e of ev) await handleParserEvent(e);
            break;
          }
          case "error":
            runError = event.message;
            break;
          default:
            break;
        }
      }
      for (const e of parser.end()) await handleParserEvent(e);

      const finalKind = lastTerminalKind(transcript.pills);
      let finalStatus: RunningTaskStatus;
      let finalError: string | undefined;
      if (finalKind === "complete_task") finalStatus = "completed";
      else if (finalKind === "fail_task") finalStatus = "failed";
      else if (finalKind === "enqueue_question") finalStatus = "awaiting_question";
      else {
        finalStatus = "failed";
        finalError =
          runError ?? "agent ended without emitting complete_task / fail_task / enqueue_question";
        await applyMutation(
          {
            kind: "fail_task",
            payload: { project_slug: slug, task_id: taskId, reason: finalError },
          },
          this.applyCtx,
        );
      }

      this.patchSlot(slotIdx, {
        status: finalStatus,
        finished_at: Date.now(),
        error: finalError,
      });

      const finished = this.slots[slotIdx];
      const record: TaskRunRecord = {
        id: runId,
        task_id: taskId,
        project_slug: slug,
        started_at: finished?.started_at ?? Date.now(),
        finished_at: Date.now(),
        status: finalStatus,
        prompt,
        raw_output: transcript.raw,
        pills: transcript.pills,
        error: finalError,
        blocking_question_id: finished?.blocking_question_id,
      };
      // Persist the run *before* announcing finish so any listener that
      // reacts to the event (e.g. the sync tool-run endpoint) can read
      // the record without racing the writer.
      await saveTaskRun(record);
      events.broadcast({
        type: "task_finished",
        project_slug: slug,
        task_id: taskId,
        run_id: runId,
        status: finalStatus,
        ts: Date.now(),
      });
    } finally {
      this.slots[slotIdx] = null;
      this.slotChildren[slotIdx] = null;
      this.slotBusy[slotIdx] = false;
      this.releaseLease(taskId);
      // Wake up the loop so the freshly-free slot picks the next task.
      // (Loop is idempotent — kickLoop early-returns if already running.)
      if (this.state.run === "running") this.kickLoop();
    }
  }

  private patchSlot(slotIdx: number, patch: Partial<RunningTask>): void {
    const slot = this.slots[slotIdx];
    if (!slot) return;
    const next = { ...slot, ...patch };
    this.slots[slotIdx] = next;
    events.broadcast({
      type: "task_progress",
      project_slug: next.project_slug,
      task_id: next.task_id,
      status: next.status,
      pills: next.pills,
      retries: next.retries,
      ts: Date.now(),
    });
  }

  private appendOutput(slotIdx: number, delta: string): void {
    const slot = this.slots[slotIdx];
    if (!slot) return;
    const nextTail = (slot.output_tail + delta).slice(-OUTPUT_TAIL_CAP);
    this.slots[slotIdx] = { ...slot, output_tail: nextTail };
    events.broadcast({
      type: "task_delta",
      project_slug: slot.project_slug,
      task_id: slot.task_id,
      delta,
      ts: Date.now(),
    });
  }

  private async applyTerminal(
    slug: string,
    body: string,
  ): Promise<TaskRunRecord["pills"][number]> {
    let envelope: unknown;
    try {
      envelope = JSON.parse(body);
    } catch (err) {
      const error = `invalid JSON: ${err instanceof Error ? err.message : String(err)}`;
      return { kind: undefined, error };
    }
    // Inject project_slug if missing — same convenience as chat-side.
    if (envelope && typeof envelope === "object") {
      const env = envelope as { payload?: Record<string, unknown> };
      if (env.payload && typeof env.payload === "object" && !("project_slug" in env.payload)) {
        env.payload.project_slug = slug;
      }
    }
    const result = await applyMutation(envelope, this.applyCtx);
    if (result.ok) {
      return { kind: result.kind, result: result.result };
    }
    return {
      kind:
        envelope && typeof envelope === "object" && "kind" in envelope
          ? String((envelope as { kind: unknown }).kind)
          : undefined,
      error: result.error,
    };
  }

  private async buildPrompt(candidate: PickerCandidate): Promise<string> {
    const slug = candidate.task.project_slug;
    const fleet = await readFleet();
    const project = fleet.projects.find((p) => p.slug === slug);
    // Phase 12: rules block is prepended to every prompt the worker
    // produces — both tool-backed and generic — so user authoring
    // (global rules + this project's rules) gates the whole run.
    const rulesBlock = await formatRulesBlock({ kind: "project", slug });

    // Phase 10: tool-backed tasks render the tool's authored prompt
    // template instead of the generic task executor. Falls through to
    // the standard prompt if the tool was archived or deleted while
    // the task was queued.
    if (candidate.task.tool_id) {
      const tools = await readTools();
      const tool = tools.find((t) => t.id === candidate.task.tool_id);
      if (tool) {
        return (
          rulesBlock +
          buildToolTaskPrompt({
            tool,
            args: candidate.task.tool_args ?? {},
            projectSlug: slug,
            workspacePath: project?.workspace_path,
            task: {
              id: candidate.task.id,
              title: candidate.task.title,
              description: candidate.task.description,
            },
          })
        );
      }
    }

    let flowText: string | undefined;
    if (candidate.feature) {
      const flows = await readFlows(slug);
      const flow = flows.find((f) => f.feature_id === candidate.feature!.id);
      if (flow) flowText = formatFlow(flow);
    }
    return (
      rulesBlock +
      buildTaskExecutionPrompt({
        projectSlug: slug,
        workspacePath: project?.workspace_path,
        task: {
          id: candidate.task.id,
          title: candidate.task.title,
          description: candidate.task.description,
          feature_id: candidate.task.feature_id,
        },
        feature: candidate.feature
          ? {
              id: candidate.feature.id,
              name: candidate.feature.name,
              description: candidate.feature.description,
            }
          : undefined,
        flowText,
      })
    );
  }

  private async optsForProject(slug: string): Promise<CursorOptions> {
    const fleet = await readFleet();
    const project = fleet.projects.find((p) => p.slug === slug);
    // Phase 20 — queue worker uses the "agent" model role (typically
    // a heavier reasoning model than chat). Resolved per-task so a
    // mid-queue model flip in the UI affects subsequent tasks
    // without restarting the worker.
    const model = await modelFor("agent", this.cursorOpts.model);
    return {
      ...this.cursorOpts,
      cwd: project?.workspace_path && project.workspace_path.length > 0
        ? project.workspace_path
        : this.cursorOpts.cwd,
      model,
      // Queue worker is the one place where --force is on by default —
      // this is the contract the user opted into when they pressed "Run".
      allowFileWrites: true,
    };
  }
}

// ---- Helpers ----------------------------------------------------------

type QueueRunStateLiteral = QueueState["run"];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function lastTerminalKind(
  pills: TaskRunRecord["pills"],
): "complete_task" | "fail_task" | "enqueue_question" | null {
  for (let i = pills.length - 1; i >= 0; i--) {
    const k = pills[i].kind;
    if (k === "complete_task" || k === "fail_task" || k === "enqueue_question") return k;
  }
  return null;
}

function formatFlow(flow: Flow): string {
  if (flow.nodes.length === 0) return "(empty flow)";
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

async function readTasksForRunOne(slug: string): Promise<Task[]> {
  // Tiny indirection so the runner doesn't pull `entities.ts` until needed.
  // Importing it eagerly at module top is also fine, but this keeps the
  // dependency surface explicit.
  const { readTasks } = await import("../storage/entities.js");
  return await readTasks(slug);
}

// ---- Singleton plumbing ----------------------------------------------

let worker: QueueWorker | null = null;

export function initQueueWorker(opts: { cursor: CursorOptions; applyCtx: ApplyContext }): QueueWorker {
  worker = new QueueWorker(opts.cursor, opts.applyCtx);
  return worker;
}

export function getQueueWorker(): QueueWorker {
  if (!worker) throw new Error("queue worker not initialized");
  return worker;
}
