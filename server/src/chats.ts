import { randomUUID } from "node:crypto";
import * as cursor from "./cursor.js";
import type { CursorEvent, CursorOptions } from "./cursor.js";
import type { Chat, ChatSummary, Message, Pill } from "./types.js";
import {
  deleteChat,
  listChats,
  loadChat,
  lockKey,
  saveChat,
  type ChatScope,
  type MemoryEntry,
  type PersistedChat,
} from "./storage/chats.js";
import { chatLocks } from "./storage/locks.js";
import { readFleet } from "./storage/fleet.js";
import { modelFor } from "./storage/settings.js";
import { readFeatures, readFlows, readTasks } from "./storage/entities.js";
import { FenceParser } from "./commands/parser.js";
import { buildRetryPrompt, commandVocabulary, type RejectionInfo } from "./commands/system_prompt.js";
import { computeCoachHint } from "./coach/hint.js";
import { applyMutation } from "./mutations/apply.js";
import { formatRulesBlock } from "./rules/inject.js";

/** Hard cap on retry passes per user turn. */
const MAX_RETRIES = 3;

/**
 * Disk-backed chat store. Scope-aware:
 *   - global chats live at `store/chats/`
 *   - per-project chats live at `store/<slug>/chats/`
 *
 * Per-project chats run cursor-agent against the project's
 * `workspace_path` (so the agent's native code tools target that repo)
 * and prepend a fresh project-context preamble to every user turn so the
 * agent always sees current state.
 *
 * Phase 2: every turn is wrapped in a `FenceParser` so ```icarus blocks
 * mid-stream are surfaced as pill events and applied as mutations on
 * close. Successful applies are recorded as `pendingMemory` on the chat
 * and replayed to the agent at the start of the *next* turn so the model
 * has a short-term memory of what it actually changed.
 */

export interface SendCallbacks {
  onChunk: (delta: string) => void;
  onTool?: (info: { name: string; phase: "started" | "completed"; detail?: string }) => void;
  onPill?: (pill: Pill) => void;
  onRetryStatus?: (info: { phase: "retrying" | "exhausted"; attempt: number; rejections: number }) => void;
}

interface ProjectContext {
  workspacePath: string;
  preamble: string;
}

export class ChatStore {
  constructor(
    private readonly cursorOpts: CursorOptions,
    private readonly applyCtx: { workspaceRoot: string },
  ) {}

  async list(scope: ChatScope): Promise<ChatSummary[]> {
    return await listChats(scope);
  }

  async get(scope: ChatScope, id: string): Promise<Chat | null> {
    const persisted = await loadChat(scope, id);
    if (!persisted) return null;
    const { cursorChatId: _ignored, pendingMemory: _ignored2, ...chat } = persisted;
    return chat;
  }

  async create(scope: ChatScope): Promise<Chat> {
    const cursorOpts = await this.optsForScope(scope);
    const cursorChatId = await cursor.createChat(cursorOpts);
    const id = randomUUID();
    const now = Date.now();
    const persisted: PersistedChat = {
      id,
      title: "New chat",
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      messages: [],
      cursorChatId,
    };
    await chatLocks.run(lockKey(scope, id), () => saveChat(scope, persisted));
    const { cursorChatId: _ignored, ...chat } = persisted;
    return chat;
  }

  async remove(scope: ChatScope, id: string): Promise<boolean> {
    return await chatLocks.run(lockKey(scope, id), () => deleteChat(scope, id));
  }

  async send(
    scope: ChatScope,
    id: string,
    text: string,
    cb: SendCallbacks,
    signal?: AbortSignal,
    /**
     * Phase 15 — opaque per-browser-session id. Threaded through to
     * every agent-emitted mutation so navigation events can be
     * targeted at the originating client. No persistence, no auth
     * meaning: a fresh tab gets a fresh id.
     */
    clientId?: string,
  ): Promise<{ user: Message; assistant: Message }> {
    const persisted = await loadChat(scope, id);
    if (!persisted) throw new Error(`unknown chat: ${id}`);

    const cursorOpts = await this.optsForScope(scope);
    const projectCtx = scope.kind === "project" ? await projectContext(scope.slug) : null;

    const userMessage: Message = {
      id: randomUUID(),
      role: "user",
      text,
      createdAt: Date.now(),
    };

    // Aggregated state across the initial pass + any retry passes. The
    // cursor session stays the same (`--resume` preserves history), so all
    // attempts share one logical assistant message.
    const pills: Pill[] = [];
    const memory: MemoryEntry[] = [];
    let assistantText = "";
    let runError: string | null = null;

    let prompt = await buildPrompt(scope, persisted.pendingMemory, projectCtx, text);
    let attempt = 0;

    while (true) {
      const passRejections: RejectionInfo[] = [];

      const result = await this.runPass({
        cursorOpts,
        cursorChatId: persisted.cursorChatId,
        prompt,
        scope,
        signal,
        cb,
        clientId,
        onText: (delta) => {
          assistantText += delta;
        },
        onPill: (pill) => {
          const idx = pills.findIndex((p) => p.id === pill.id);
          if (idx >= 0) pills[idx] = pill;
          else pills.push(pill);
          if (pill.phase === "applied") {
            memory.push({
              kind: pill.kind ?? "unknown",
              summary: summarize(pill),
              ts: Date.now(),
              outcome: "applied",
            });
          } else if (pill.phase === "rejected") {
            passRejections.push({
              kind: pill.kind,
              error: pill.error ?? "unknown error",
              body: pill.body,
            });
          }
        },
      });
      if (result.error) runError = result.error;

      if (passRejections.length === 0) break;

      if (attempt >= MAX_RETRIES) {
        // Burned the budget. Fold a terse note into the assistant text and
        // persist the final rejections as memory so the next turn (and any
        // future council pass) can see we gave up.
        const note = retryExhaustedNote(passRejections);
        assistantText += note;
        cb.onChunk(note);
        for (const r of passRejections) {
          memory.push({
            kind: r.kind ?? "unknown",
            summary: `${truncate(r.error, 160)} (retries exhausted)`,
            ts: Date.now(),
            outcome: "rejected_terminal",
          });
        }
        cb.onRetryStatus?.({ phase: "exhausted", attempt, rejections: passRejections.length });
        break;
      }

      attempt += 1;
      const remaining = MAX_RETRIES - attempt + 1;
      const banner = retryBanner(attempt, MAX_RETRIES);
      assistantText += banner;
      cb.onChunk(banner);
      cb.onRetryStatus?.({ phase: "retrying", attempt, rejections: passRejections.length });
      prompt = buildRetryPrompt(passRejections, attempt, remaining);
    }

    if (runError && assistantText.length === 0 && pills.length === 0) {
      throw new Error(runError);
    }

    const assistantMessage: Message = {
      id: randomUUID(),
      role: "assistant",
      text: assistantText,
      createdAt: Date.now(),
      pills: pills.length > 0 ? pills : undefined,
    };

    await chatLocks.run(lockKey(scope, id), async () => {
      const fresh = await loadChat(scope, id);
      if (!fresh) throw new Error(`chat went missing: ${id}`);
      const updated: PersistedChat = {
        ...fresh,
        messages: [...fresh.messages, userMessage, assistantMessage],
        messageCount: fresh.messages.length + 2,
        updatedAt: Date.now(),
        title:
          fresh.messages.length === 0 && fresh.title === "New chat"
            ? text.slice(0, 60).trim() || fresh.title
            : fresh.title,
        pendingMemory: memory.length > 0 ? memory : undefined,
      };
      await saveChat(scope, updated);
    });

    return { user: userMessage, assistant: assistantMessage };
  }

  /**
   * One round-trip with cursor-agent: stream deltas through the fence
   * parser, apply each closed fence, and emit pill events. Returns when
   * the cursor stream ends (caller decides whether to retry).
   */
  private async runPass(args: {
    cursorOpts: CursorOptions;
    cursorChatId: string;
    prompt: string;
    scope: ChatScope;
    signal?: AbortSignal;
    cb: SendCallbacks;
    /** See ChatStore.send — propagated into agent-emitted envelopes. */
    clientId?: string;
    onText: (delta: string) => void;
    onPill: (pill: Pill) => void;
  }): Promise<{ error: string | null }> {
    const parser = new FenceParser();
    let runError: string | null = null;

    const handleParserEvent = async (
      ev: { type: "text"; text: string } | { type: "pill_open"; id: string } | { type: "pill_close"; id: string; body: string },
    ) => {
      if (ev.type === "text") {
        args.onText(ev.text);
        args.cb.onChunk(ev.text);
      } else if (ev.type === "pill_open") {
        const pill: Pill = { id: ev.id, phase: "pending" };
        args.onPill(pill);
        args.cb.onPill?.(pill);
      } else {
        const closed = await closePill(ev.id, ev.body, args.scope, this.applyCtx, args.clientId);
        args.onPill(closed);
        args.cb.onPill?.(closed);
      }
    };

    for await (const event of cursor.sendTurn(args.cursorOpts, args.cursorChatId, args.prompt, args.signal)) {
      const handlers = makeCursorHandlers({
        onDelta: (delta) => parser.feed(delta),
        onTool: args.cb.onTool ?? (() => {}),
        onError: (msg) => {
          runError = msg;
        },
      });
      const events = handlers(event);
      for (const ev of events) await handleParserEvent(ev);
    }
    for (const ev of parser.end()) await handleParserEvent(ev);

    return { error: runError };
  }

  /**
   * Resolve cursor-agent options per scope.
   *
   * Two things we override on top of the static `cursorOpts` baked
   * in at server startup:
   *   - `cwd` — project chats run with the project's workspace
   *     directory as cwd (so the agent's `read_file` etc. resolve
   *     against the project, not the icarus repo root).
   *   - `model` — sourced from `settings.json`'s `models.chat`
   *     entry, refreshed on every turn so flipping the model in
   *     the UI takes effect on the *next* user message with no
   *     server restart. Falls back to `cursorOpts.model` (the
   *     `CURSOR_MODEL` env) when no chat model is set, then to
   *     cursor-agent's CLI default.
   */
  private async optsForScope(scope: ChatScope): Promise<CursorOptions> {
    const model = await modelFor("chat", this.cursorOpts.model);
    if (scope.kind === "global") {
      return { ...this.cursorOpts, model };
    }
    const fleet = await readFleet();
    const project = fleet.projects.find((p) => p.slug === scope.slug);
    if (!project) throw new Error(`unknown project: ${scope.slug}`);
    const cwd = await resolveProjectCwd(project.workspace_path, this.cursorOpts.cwd);
    return {
      ...this.cursorOpts,
      cwd,
      model,
    };
  }
}

/**
 * Resolve a project's `workspace_path` to a directory that
 * actually exists on the host running the server.
 *
 * Why this needs to be smart: a project created while the
 * server ran inside Docker stamped a *container* path like
 * `/workspace/<slug>` into fleet.json. After we pivot the
 * server to native (so it can reach LAN voice services on
 * macOS), that container path doesn't exist on the host —
 * `spawn(binary, ..., { cwd })` then fails to `chdir()` and
 * surfaces as the misleading `spawn cursor-agent ENOENT`
 * (it's the cwd that's missing, not the binary).
 *
 * Strategy:
 *   1. If the stored path exists on disk, use it (covers the
 *      happy path: server still in Docker, or native created
 *      project pointed at a real host dir).
 *   2. Otherwise, if it looks like the legacy container path
 *      `/workspace/<rest>`, translate to
 *      `${WORKSPACE_ROOT}/<rest>` and use that if it exists.
 *      `WORKSPACE_ROOT` is what the dev-native launcher sets
 *      to whatever was bind-mounted to `/workspace` in docker.
 *   3. Otherwise, fall back to the server's default cwd
 *      (`process.cwd()` in native, the icarus repo). Logged
 *      as a warning so the operator knows the project
 *      effectively has no workspace until they fix it.
 */
async function resolveProjectCwd(
  storedPath: string | undefined,
  fallback: string,
): Promise<string> {
  if (!storedPath || storedPath.length === 0) return fallback;

  const { existsSync } = await import("node:fs");
  if (existsSync(storedPath)) return storedPath;

  const containerPrefix = "/workspace/";
  const root = process.env.WORKSPACE_ROOT;
  if (storedPath.startsWith(containerPrefix) && root && root.length > 0) {
    const translated = `${root}/${storedPath.slice(containerPrefix.length)}`;
    if (existsSync(translated)) {
      console.warn(
        `[chats] translated container path ${storedPath} → ${translated} (server is native; fix fleet.json with update_project to make this permanent)`,
      );
      return translated;
    }
  }

  console.warn(
    `[chats] project workspace_path ${storedPath} does not exist on this host; falling back to ${fallback} (use update_project to fix)`,
  );
  return fallback;
}

async function buildPrompt(
  scope: ChatScope,
  pendingMemory: MemoryEntry[] | undefined,
  projectCtx: ProjectContext | null,
  userText: string,
): Promise<string> {
  // Phase 12: rules-as-prompt-prefix. The block is the very first
  // thing the agent sees so global/project guidance gates everything
  // that follows. Skipped (empty string) when no rules are active.
  const rulesBlock = await formatRulesBlock(
    scope.kind === "project" ? { kind: "project", slug: scope.slug } : { kind: "global" },
  );
  // Phase 16: coach hint. Reads the world state (projects /
  // features / flows / architecture / tasks) and tells the agent
  // what would naturally come next. Lives between the project
  // context (descriptive) and the user text (the actual ask) —
  // close to the end so it's "fresh" in the agent's window, but
  // not so close it overrides what the user actually said.
  const coachHint = await computeCoachHint(
    scope.kind === "project" ? { kind: "project", slug: scope.slug } : { kind: "global" },
  );
  const parts: string[] = [];
  if (rulesBlock) parts.push(rulesBlock.trimEnd());
  parts.push(commandVocabulary(scope));
  if (pendingMemory && pendingMemory.length > 0) {
    parts.push(memoryBlock(pendingMemory));
  }
  if (projectCtx) {
    parts.push(projectCtx.preamble);
  }
  if (coachHint) parts.push(coachHint);
  parts.push(userText);
  return parts.join("\n\n");
}

function memoryBlock(entries: MemoryEntry[]): string {
  const lines = entries.map((e, i) => {
    const tag = e.outcome === "rejected_terminal" ? " [FAILED — retries exhausted]" : "";
    return `  ${i + 1}. ${e.kind} — ${e.summary}${tag}`;
  });
  const hasFailure = entries.some((e) => e.outcome === "rejected_terminal");
  const footer = hasFailure
    ? "(at least one command from your previous turn could not be completed; acknowledge the failure if relevant)"
    : "(continue the conversation; do not repeat these actions unless asked)";
  return [
    "[icarus memory — outcomes from your previous turn]",
    ...lines,
    footer,
  ].join("\n");
}

function retryBanner(attempt: number, max: number): string {
  return `\n\n_[icarus] command rejected — auto-retrying (${attempt}/${max})…_\n\n`;
}

function retryExhaustedNote(rejections: RejectionInfo[]): string {
  const first = rejections[0];
  const reason = first ? truncate(first.error, 200) : "unknown";
  return [
    "",
    "",
    "_[icarus] retry budget exhausted — the agent could not produce a valid",
    `command after ${MAX_RETRIES} retries. Last error:_ \`${reason}\``,
    "",
  ].join("\n");
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function summarize(pill: Pill): string {
  if (!pill.result || typeof pill.result !== "object") return pill.kind ?? "ok";
  const r = pill.result as Record<string, unknown>;

  // Pull id+label from common nested shapes so the next turn can compose
  // off this one (e.g. add_feature returns { feature: { id, name } } and
  // the agent needs `id` to build downstream `add_flow_node` calls).
  const project = r.project as { slug?: string; name?: string } | undefined;
  if (project?.slug) {
    return project.name ? `slug=${project.slug} name="${project.name}"` : `slug=${project.slug}`;
  }
  const feature = r.feature as { id?: string; name?: string; status?: string } | undefined;
  if (feature?.id) {
    const bits = [`id=${feature.id}`];
    if (feature.name) bits.push(`name="${feature.name}"`);
    if (feature.status) bits.push(`status=${feature.status}`);
    return bits.join(" ");
  }
  const node = r.node as { id?: string; label?: string } | undefined;
  if (node?.id) {
    return node.label ? `id=${node.id} label="${node.label}"` : `id=${node.id}`;
  }
  const edge = r.edge as { id?: string; from_node_id?: string; to_node_id?: string } | undefined;
  if (edge?.id) {
    return `id=${edge.id} from=${edge.from_node_id} to=${edge.to_node_id}`;
  }
  const task = r.task as { id?: string; title?: string; status?: string } | undefined;
  if (task?.id) {
    const bits = [`id=${task.id}`];
    if (task.title) bits.push(`title="${task.title}"`);
    if (task.status) bits.push(`status=${task.status}`);
    return bits.join(" ");
  }
  if (typeof r.slug === "string") return `slug=${r.slug}`;
  return JSON.stringify(r);
}

async function closePill(
  id: string,
  body: string,
  scope: ChatScope,
  ctx: { workspaceRoot: string },
  /** See ChatStore.send — injected into the parsed envelope so the
   * navigate verb can target the originating client. */
  clientId?: string,
): Promise<Pill> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    return {
      id,
      phase: "rejected",
      error: `invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
      body,
    };
  }

  // Project-scoped chats can omit project_slug in payloads — inject it here
  // before the schema runs so schemas don't need a scope-aware dance.
  if (scope.kind === "project" && parsed && typeof parsed === "object") {
    const env = parsed as { payload?: Record<string, unknown> };
    if (env.payload && typeof env.payload === "object" && !("project_slug" in env.payload)) {
      env.payload.project_slug = scope.slug;
    }
  }

  // Phase 15 — inject the originating client_id so the navigate verb
  // (and any future client-targeted broadcast) can route to the right
  // browser tab. Always overwritten by the chat plumbing — the agent
  // is never told the client_id and shouldn't try to set it.
  if (parsed && typeof parsed === "object" && clientId) {
    (parsed as { client_id?: string }).client_id = clientId;
  }

  const result = await applyMutation(parsed, ctx);
  if (result.ok) {
    return { id, phase: "applied", kind: result.kind, result: result.result };
  }
  return {
    id,
    phase: "rejected",
    kind:
      parsed && typeof parsed === "object" && "kind" in parsed
        ? String((parsed as { kind: unknown }).kind)
        : undefined,
    error: result.error,
    body,
  };
}

async function projectContext(slug: string): Promise<ProjectContext | null> {
  const fleet = await readFleet();
  const project = fleet.projects.find((p) => p.slug === slug);
  if (!project) return null;

  const { readArchitecture } = await import("./storage/entities.js");
  const [features, flows, tasks, architecture] = await Promise.all([
    readFeatures(slug),
    readFlows(slug),
    readTasks(slug),
    readArchitecture(slug),
  ]);

  const activeFeatures = features.filter((f) => f.status !== "archived");
  const taskCounts = tasks.reduce<Record<string, number>>((acc, t) => {
    acc[t.status] = (acc[t.status] ?? 0) + 1;
    return acc;
  }, {});

  const lines: (string | null)[] = [
    "[icarus project context — fresh each turn]",
    `slug: ${project.slug}`,
    `name: ${project.name}`,
    project.description ? `description: ${project.description}` : null,
    `workspace: ${project.workspace_path ?? "(planning-only)"}`,
    `status: ${project.status}`,
  ];

  if (activeFeatures.length === 0) {
    lines.push("features: (none)");
  } else {
    lines.push(`features (${activeFeatures.length}):`);
    for (const f of activeFeatures.slice(0, 12)) {
      lines.push(`  - id=${f.id} name="${f.name}" status=${f.status}`);
      const flow = flows.find((fl) => fl.feature_id === f.id);
      if (flow && (flow.nodes.length > 0 || flow.edges.length > 0)) {
        const nodeBits = flow.nodes
          .slice(0, 8)
          .map((n) => `${n.id}:"${n.label}"`)
          .join(", ");
        lines.push(`      nodes: ${nodeBits}${flow.nodes.length > 8 ? ` (+${flow.nodes.length - 8} more)` : ""}`);
        if (flow.edges.length > 0) {
          const edgeBits = flow.edges
            .slice(0, 6)
            .map((e) => `${e.id}:${e.from_node_id}→${e.to_node_id}`)
            .join(", ");
          lines.push(`      edges: ${edgeBits}${flow.edges.length > 6 ? ` (+${flow.edges.length - 6} more)` : ""}`);
        }
      }
    }
  }

  lines.push(
    `tasks: ${Object.entries(taskCounts).map(([k, v]) => `${k}=${v}`).join(", ") || "(none)"}`,
  );

  // Architecture summary — agents need to know whether the planning gate
  // is open (arch has services AND approved_at) before proposing
  // request_task_planning.
  if (architecture.services.length === 0) {
    lines.push("architecture: (empty — task_planning is BLOCKED until services are added and approved)");
  } else {
    const svcBits = architecture.services
      .slice(0, 8)
      .map((s) => `${s.id}:"${s.name}"(${s.kind ?? "service"})`)
      .join(", ");
    const approvedHint = architecture.approved_at
      ? `approved=${new Date(architecture.approved_at).toISOString()}`
      : "approved=NO (task_planning BLOCKED until user clicks Approve on Architecture tab)";
    lines.push(
      `architecture (${architecture.services.length} services, ${architecture.edges.length} edges, ${approvedHint}):`,
    );
    lines.push(
      `  services: ${svcBits}${architecture.services.length > 8 ? ` (+${architecture.services.length - 8} more)` : ""}`,
    );
  }

  return {
    workspacePath: project.workspace_path ?? "",
    preamble: lines.filter((l): l is string => l !== null).join("\n"),
  };
}

type ParserEvent = ReturnType<FenceParser["feed"]>[number];

/**
 * Translate a CursorEvent into zero or more parser events, applying side
 * effects (tool callback, error capture). The caller routes parser events
 * through the FenceParser instance.
 */
function makeCursorHandlers(handlers: {
  onDelta: (delta: string) => ParserEvent[];
  onTool: (info: { name: string; phase: "started" | "completed"; detail?: string }) => void;
  onError: (message: string) => void;
}): (event: CursorEvent) => ParserEvent[] {
  return (event) => {
    switch (event.kind) {
      case "delta":
        return handlers.onDelta(event.text);
      case "tool":
        handlers.onTool({ name: event.name, phase: event.phase, detail: event.detail });
        return [];
      case "error":
        handlers.onError(event.message);
        return [];
      case "init":
      case "result":
        return [];
    }
  };
}
