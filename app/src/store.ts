import { create } from "zustand";
import * as api from "./api";
import { subscribe as subscribeEvents } from "./events";
import { getClientId } from "./voice/client_id";
import { getRecorder, getSpeaker, voiceClientSupported } from "./voice/controller";

/**
 * Module-scoped auto-clear timers for the transient task-highlight
 * action. Lives outside Zustand so a re-render can't cancel a
 * pending clear, and so a second highlight on the same slug can
 * cancel its predecessor cleanly.
 */
const highlightTaskTimers = new Map<string, ReturnType<typeof setTimeout>>();
import {
  scopeKey,
  type ActivityEntry,
  type Chat,
  type ChatScope,
  type ChatSummary,
  type CouncilRun,
  type CronJob,
  type Feature,
  type Flow,
  type GlobalTab,
  type Message,
  type Architecture,
  type Pill,
  type ProjectDetail,
  type ProjectListing,
  type ProjectTab,
  type Question,
  type Persona,
  type QueueSnapshot,
  type ResolvedPersona,
  type Rule,
  type Task,
  type Tool,
  type ToolProposal,
  type View,
} from "./types";

/**
 * Single zustand store with scope-aware chat state. Everything is keyed by
 * `scopeKey(scope)` ("global" | "project:<slug>") so the same UI components
 * render either the global or per-project chat without knowing the scope.
 *
 * `view` drives which scope the UI is currently looking at; sidebar
 * actions (selectGlobal / selectProject) flip it.
 */

interface ChatState {
  view: View;
  projects: ProjectListing[];
  projectDetailBySlug: Record<string, ProjectDetail>;

  /** Chat lists keyed by scopeKey. */
  chatsByScope: Record<string, ChatSummary[]>;
  /** Active chat id keyed by scopeKey. */
  activeChatByScope: Record<string, string | null>;

  messagesByChat: Record<string, Message[]>;
  streamingByChat: Record<string, string>;
  /** Pills emitted during the in-flight assistant turn, by chatId. */
  streamingPillsByChat: Record<string, Pill[]>;
  busyByChat: Record<string, boolean>;

  activityByScope: Record<string, ActivityEntry[]>;

  /** Per-project entity caches keyed by project slug. */
  featuresBySlug: Record<string, Feature[]>;
  flowsBySlug: Record<string, Flow[]>;
  tasksBySlug: Record<string, Task[]>;
  /** Currently-focused feature on the Flows tab, per project. */
  selectedFeatureBySlug: Record<string, string | null>;
  /**
   * Phase 15 — transient task highlight, per project. Set by the
   * `nav_request` handler when the agent navigates to a specific
   * task ("open task foo"). Auto-clears after a few seconds so the
   * highlight reads as a one-shot "ping" rather than a sticky
   * selection. Tasks aren't a selectable concept anywhere else, so
   * this lives only as a transient signal.
   */
  highlightedTaskBySlug: Record<string, string | null>;
  /** Council runs per feature, keyed by `<slug>::<feature_id>`. */
  councilRunsByFeature: Record<string, CouncilRun[]>;

  /** Queue snapshot — single global object kept in sync via WS events. */
  queue: QueueSnapshot;
  /** Live tail buffer for the running task, accumulated from task_delta events. */
  runningTaskTail: string;
  /** Per-project question lists (open + answered + dismissed). */
  questionsBySlug: Record<string, Question[]>;

  /** Per-project architecture (services + edges). */
  architectureBySlug: Record<string, Architecture>;

  /** Phase 10/11: global tool registry + cron schedule. */
  tools: Tool[];
  cronJobs: CronJob[];

  /** Phase 12: rules — global registry + per-project, keyed by slug. */
  globalRules: Rule[];
  rulesBySlug: Record<string, Rule[]>;

  /** Phase 13: agent-emitted tool suggestions, pending review. */
  toolProposals: ToolProposal[];

  /** Phase 14: council personas — global registry + per-project. */
  globalPersonas: Persona[];
  personasBySlug: Record<string, Persona[]>;
  /**
   * Resolved lens panel cache. The `__global` key holds the pure-
   * global resolution (what the council would run with no project
   * scope). Per-project keys hold the project-scoped resolution.
   */
  resolvedPersonasBySlug: Record<string, ResolvedPersona[]>;

  /**
   * Phase 15 — voice. `available` is the conjunction of server-side
   * STT/TTS health and client-side recorder/speaker support.
   * `state` drives the floating mic button's color and the preview
   * bubble's visibility.
   *
   *   idle         — no recording, no pending transcript, no playback.
   *   recording    — mic open, button pulses red.
   *   transcribing — audio uploaded, waiting on STT, button shows amber spinner.
   *   pending      — STT returned; transcript shown in the preview
   *                  bubble awaiting confirm / re-record / discard.
   *                  This is the "show me what I'm saying so I can
   *                  confirm" stage.
   *   speaking     — assistant reply playing back, button shows violet.
   *
   * `pendingTranscript` holds the editable transcript while in
   * `pending`. The user can hand-edit it, re-record (replaces), or
   * confirm (fires the chat send).
   *
   * `lastInputWasVoice` flips on at confirm-and-send, controls
   * whether the next assistant turn gets played through TTS.
   */
  voice: {
    available: boolean;
    /**
     * Phase 19 — surfaced from `/v1/voice/health`. `true` when the
     * user has flipped the global voice toggle off, so the
     * sidebar can render a distinct "VOICE OFF" pill instead of
     * the generic "offline" amber state.
     */
    userDisabled: boolean;
    healthReason?: string;
    state: "idle" | "recording" | "transcribing" | "pending" | "speaking";
    pendingTranscript: string | null;
    error: string | null;
    lastInputWasVoice: boolean;
    /**
     * Phase 15.2 — where the next confirmed transcript routes.
     *
     * `chat` (default) is the existing flow: confirmed text becomes
     * a normal chat message. `question` redirects the next confirm
     * into an `answer_question` mutation, set when the user clicks
     * a question's SPEAK button so they can answer it by voice.
     *
     * Typing always goes to chat — this only affects the voice
     * confirm-and-send path. Auto-resets to `chat` after a
     * confirm/discard/cancel so a stale target doesn't redirect a
     * later utterance the user forgot they queued up.
     */
    target:
      | { kind: "chat" }
      | {
          kind: "question";
          question_id: string;
          project_slug: string;
          preview: string;
        };
  };

  /**
   * Phase 20 — per-role cursor-agent model selection. `loaded` is
   * `false` until the first `/v1/settings/models` fetch resolves,
   * so the Settings UI can render a "loading" state instead of
   * defaulting visibly to empty.
   */
  models: {
    chat: string;
    agent: string;
    loaded: boolean;
  };

  error: string | null;

  // ---- View ----
  selectGlobal: (tab?: GlobalTab) => void;
  setGlobalTab: (tab: GlobalTab) => void;
  selectProject: (slug: string, tab?: ProjectTab) => Promise<void>;
  setProjectTab: (tab: ProjectTab) => void;

  // ---- Projects ----
  refreshProjects: () => Promise<void>;
  refreshProjectDetail: (slug: string) => Promise<void>;
  createProject: (input: {
    name: string;
    description?: string;
    workspace_path?: string | "auto" | null;
  }) => Promise<ProjectListing | null>;
  archiveProject: (slug: string) => Promise<void>;

  // ---- Chats (operate on the current view's scope) ----
  refreshChats: () => Promise<void>;
  selectChat: (id: string) => Promise<void>;
  newChat: () => Promise<void>;
  removeChat: (id: string) => Promise<void>;
  send: (text: string) => Promise<void>;

  // ---- Activity ----
  refreshActivity: () => Promise<void>;

  // ---- Features / Flows / Tasks ----
  refreshFeatures: (slug: string) => Promise<void>;
  refreshFlows: (slug: string) => Promise<void>;
  refreshTasks: (slug: string) => Promise<void>;
  selectFeature: (slug: string, featureId: string | null) => void;
  /**
   * Set a transient highlight on a task card. Auto-clears after
   * `ttlMs` (default 5000). Pass `null` for taskId to clear
   * immediately. Cancels any prior auto-clear timer for the same
   * slug so consecutive nav events don't cancel each other early.
   */
  highlightTask: (slug: string, taskId: string | null, ttlMs?: number) => void;
  /** Apply any mutation envelope and refresh whatever it touched. Returns true on success. */
  applyAndRefresh: (envelope: unknown, slugForRefresh?: string) => Promise<boolean>;

  // ---- Council ----
  refreshCouncilRuns: (slug: string, featureId: string) => Promise<void>;

  // ---- Queue / Questions ----
  refreshQueue: () => Promise<void>;
  refreshQuestions: (slug: string) => Promise<void>;

  // ---- Architecture ----
  refreshArchitecture: (slug: string) => Promise<void>;

  // ---- Tools / Cron ----
  refreshTools: () => Promise<void>;
  refreshCronJobs: () => Promise<void>;

  // ---- Voice (Phase 15) ----
  /**
   * Probe `/v1/voice/health` and update `voice.available`. Called
   * once at startup; the UI hides the mic button when unavailable.
   */
  refreshVoiceHealth: () => Promise<void>;
  /**
   * Phase 20 — fetch `/v1/settings/models` and update the
   * `models` slice. Called at startup, on entering the Settings
   * tab, and on `model_settings_changed` WS events.
   */
  refreshModelSettings: () => Promise<void>;
  /**
   * Begin push-to-talk recording. Sets `voice.state = "recording"`.
   * Clears any prior `pendingTranscript` — re-arming is the
   * "talk to change it" path: each new utterance replaces.
   */
  voiceArm: () => Promise<void>;
  /**
   * Stop recording, transcribe, hold the transcript in
   * `pendingTranscript` and flip to `state: "pending"` so the user
   * can review it before sending. The preview bubble surfaces the
   * three follow-up actions below.
   */
  voiceStopAndPreview: () => Promise<void>;
  /**
   * Manually edit the held transcript (e.g. when STT mishears a
   * proper noun and the user wants to fix it with the keyboard
   * instead of re-recording).
   */
  voiceEditPending: (text: string) => void;
  /**
   * Confirm the held transcript and fire the chat send. Flips
   * `lastInputWasVoice` so the assistant reply is spoken back.
   */
  voiceConfirmAndSend: () => Promise<void>;
  /** Throw away the held transcript; back to `idle`. */
  voiceDiscardPending: () => void;
  /** Cancel an in-flight arm/recording without sending. */
  voiceCancel: () => void;
  /** Internal — flipped by the chat send path when input came from voice. */
  setVoiceState: (next: Partial<ChatState["voice"]>) => void;
  /**
   * Phase 15.2 — read aloud the body of an open question and lock
   * the voice target to it, so the next confirmed transcript fires
   * an `answer_question` mutation instead of going to chat.
   *
   * Cancels any in-flight playback or recording first (consistent
   * with the global "speak something new → stop everything else"
   * rule). Voice mode does NOT auto-arm the mic after the audio
   * finishes; the user clicks the mic when they're ready to talk.
   */
  speakQuestion: (question: Question) => Promise<void>;
  /**
   * Reset the voice target back to `chat` without touching the
   * recording/pending state. Used by the "answering question"
   * banner's ✕ affordance for users who clicked a question by
   * mistake or just wanted to listen.
   */
  clearVoiceTarget: () => void;

  // ---- Rules (Phase 12) ----
  refreshGlobalRules: () => Promise<void>;
  refreshProjectRules: (slug: string) => Promise<void>;

  // ---- Tool Proposals (Phase 13) ----
  refreshToolProposals: () => Promise<void>;

  // ---- Personas (Phase 14) ----
  refreshGlobalPersonas: () => Promise<void>;
  refreshProjectPersonas: (slug: string) => Promise<void>;
  refreshResolvedPersonas: (slug?: string) => Promise<void>;
}

function viewScope(view: View): ChatScope {
  return view.kind === "global" ? { kind: "global" } : { kind: "project", slug: view.slug };
}

const tempUserMessage = (text: string): Message => ({
  id: `local-${Date.now()}`,
  role: "user",
  text,
  createdAt: Date.now(),
});

export const useChatStore = create<ChatState>((set, get) => ({
  view: { kind: "global", tab: "chat" },
  projects: [],
  projectDetailBySlug: {},
  chatsByScope: {},
  activeChatByScope: {},
  messagesByChat: {},
  streamingByChat: {},
  streamingPillsByChat: {},
  busyByChat: {},
  activityByScope: {},
  featuresBySlug: {},
  flowsBySlug: {},
  tasksBySlug: {},
  selectedFeatureBySlug: {},
  highlightedTaskBySlug: {},
  councilRunsByFeature: {},
  queue: {
    state: { run: "idle", scope: {}, changed_at: 0 },
    current: null,
    running: [],
  },
  runningTaskTail: "",
  questionsBySlug: {},
  architectureBySlug: {},
  tools: [],
  cronJobs: [],
  globalRules: [],
  rulesBySlug: {},
  toolProposals: [],
  globalPersonas: [],
  personasBySlug: {},
  resolvedPersonasBySlug: {},
  voice: {
    available: false,
    userDisabled: false,
    state: "idle",
    pendingTranscript: null,
    error: null,
    lastInputWasVoice: false,
    target: { kind: "chat" },
  },
  models: {
    chat: "",
    agent: "",
    loaded: false,
  },
  error: null,

  // ---- View ----
  selectGlobal(tab: GlobalTab = "chat") {
    set({ view: { kind: "global", tab }, error: null });
    if (tab === "tools") {
      void get().refreshTools();
      void get().refreshToolProposals();
    }
    if (tab === "cron") {
      void get().refreshTools();
      void get().refreshCronJobs();
    }
    if (tab === "rules") void get().refreshGlobalRules();
    if (tab === "personas") {
      void get().refreshGlobalPersonas();
      void get().refreshResolvedPersonas();
    }
    if (tab === "settings") void get().refreshModelSettings();
  },
  setGlobalTab(tab) {
    const view = get().view;
    if (view.kind !== "global") return;
    set({ view: { kind: "global", tab } });
    if (tab === "tools") {
      void get().refreshTools();
      void get().refreshToolProposals();
    }
    if (tab === "cron") {
      void get().refreshTools();
      void get().refreshCronJobs();
    }
    if (tab === "rules") void get().refreshGlobalRules();
    if (tab === "personas") {
      void get().refreshGlobalPersonas();
      void get().refreshResolvedPersonas();
    }
    if (tab === "settings") void get().refreshModelSettings();
  },
  async selectProject(slug, tab = "chat") {
    set({ view: { kind: "project", slug, tab }, error: null });
    void get().refreshProjectDetail(slug);
    void get().refreshChats();
    void get().refreshFeatures(slug);
    void get().refreshTasks(slug);
    void get().refreshFlows(slug);
    void get().refreshQuestions(slug);
    void get().refreshQueue();
    if (tab === "activity") void get().refreshActivity();
  },
  setProjectTab(tab) {
    const view = get().view;
    if (view.kind !== "project") return;
    set({ view: { ...view, tab } });
    if (tab === "activity") void get().refreshActivity();
    if (tab === "features") void get().refreshFeatures(view.slug);
    if (tab === "tasks") void get().refreshTasks(view.slug);
    if (tab === "flows") {
      void get().refreshFeatures(view.slug);
      void get().refreshFlows(view.slug);
    }
    if (tab === "questions") void get().refreshQuestions(view.slug);
    if (tab === "code") void get().refreshArchitecture(view.slug);
    if (tab === "architecture") void get().refreshArchitecture(view.slug);
    if (tab === "rules") void get().refreshProjectRules(view.slug);
    if (tab === "personas") {
      void get().refreshProjectPersonas(view.slug);
      void get().refreshGlobalPersonas();
      void get().refreshResolvedPersonas(view.slug);
    }
  },

  // ---- Projects ----
  async refreshProjects() {
    try {
      const projects = await api.listProjects();
      set({ projects, error: null });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "failed to load projects" });
    }
  },
  async refreshProjectDetail(slug) {
    try {
      const detail = await api.getProject(slug);
      set((s) => ({ projectDetailBySlug: { ...s.projectDetailBySlug, [slug]: detail } }));
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "failed to load project" });
    }
  },
  async createProject(input) {
    try {
      const res = await api.applyMutation({
        kind: "create_project",
        payload: input,
      });
      if (!res.ok) {
        set({ error: res.error ?? "failed to create project" });
        return null;
      }
      const project = (res.result as { project: ProjectListing }).project;
      set((s) => ({ projects: [project, ...s.projects.filter((p) => p.slug !== project.slug)] }));
      return project;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "failed to create project" });
      return null;
    }
  },
  async archiveProject(slug) {
    try {
      const res = await api.applyMutation({
        kind: "archive_project",
        payload: { slug },
      });
      if (!res.ok) {
        set({ error: res.error ?? "failed to archive" });
        return;
      }
      set((s) => ({ projects: s.projects.filter((p) => p.slug !== slug) }));
      if (get().view.kind === "project" && (get().view as { slug: string }).slug === slug) {
        get().selectGlobal();
      }
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "failed to archive" });
    }
  },

  // ---- Chats (current scope) ----
  async refreshChats() {
    const scope = viewScope(get().view);
    const key = scopeKey(scope);
    try {
      const chats = await api.listChats(scope);
      set((s) => ({ chatsByScope: { ...s.chatsByScope, [key]: chats }, error: null }));

      // Phase 21 — keep the chat tab usable after navigating to a
      // scope for the first time (or after a brand-new project was
      // just created by the user OR by the agent via `navigate`).
      //
      // Without this, "+ NEW PROJECT" → land on the project would
      // sit on a dead composer (`disabled={busy || !activeChatId}`)
      // because the new project has zero chats and no chat was
      // ever picked. Same situation when the user manually deletes
      // the last chat in a scope, or when another tab archives
      // the chat we had cached as active.
      //
      // Self-heal in 3 cases:
      //   1. We have an active chat for this scope and it still
      //      exists in the list → leave it (most common; no-op).
      //   2. We don't have an active chat (or the cached one was
      //      deleted) and the list has at least one chat → pick
      //      the most recent (chats are returned newest-first).
      //   3. The list is empty → create a fresh chat so the user
      //      can talk immediately. The new chat's id becomes the
      //      active chat as a side-effect of `newChat`.
      const activeId = get().activeChatByScope[key];
      const activeStillValid = !!activeId && chats.some((c) => c.id === activeId);
      if (activeStillValid) return;

      if (chats.length > 0) {
        await get().selectChat(chats[0].id);
      } else {
        await get().newChat();
      }
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "failed to load chats" });
    }
  },

  async selectChat(id) {
    const scope = viewScope(get().view);
    const key = scopeKey(scope);
    set((s) => ({
      activeChatByScope: { ...s.activeChatByScope, [key]: id },
      error: null,
    }));
    if (get().messagesByChat[id]) return;
    try {
      const chat = await api.getChat(scope, id);
      set((s) => ({
        messagesByChat: { ...s.messagesByChat, [id]: chat.messages },
      }));
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "failed to load chat" });
    }
  },

  async newChat() {
    const scope = viewScope(get().view);
    const key = scopeKey(scope);
    try {
      const chat = await api.createChat(scope);
      set((s) => ({
        chatsByScope: {
          ...s.chatsByScope,
          [key]: [summarize(chat), ...((s.chatsByScope[key] ?? []).filter((c) => c.id !== chat.id))],
        },
        activeChatByScope: { ...s.activeChatByScope, [key]: chat.id },
        messagesByChat: { ...s.messagesByChat, [chat.id]: chat.messages },
        error: null,
      }));
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "failed to create chat" });
    }
  },

  async removeChat(id) {
    const scope = viewScope(get().view);
    const key = scopeKey(scope);
    try {
      await api.deleteChat(scope, id);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "failed to delete chat" });
      return;
    }
    set((s) => {
      const { [id]: _msg, ...messagesByChat } = s.messagesByChat;
      const { [id]: _busy, ...busyByChat } = s.busyByChat;
      const { [id]: _stream, ...streamingByChat } = s.streamingByChat;
      const chats = (s.chatsByScope[key] ?? []).filter((c) => c.id !== id);
      const activeId =
        s.activeChatByScope[key] === id ? chats[0]?.id ?? null : s.activeChatByScope[key];
      return {
        messagesByChat,
        busyByChat,
        streamingByChat,
        chatsByScope: { ...s.chatsByScope, [key]: chats },
        activeChatByScope: { ...s.activeChatByScope, [key]: activeId },
      };
    });
  },

  async send(text) {
    const trimmed = text.trim();
    if (!trimmed) return;
    const scope = viewScope(get().view);
    const key = scopeKey(scope);
    const chatId = get().activeChatByScope[key];
    if (!chatId) return;
    if (get().busyByChat[chatId]) return;

    const userMessage = tempUserMessage(trimmed);
    set((s) => ({
      messagesByChat: {
        ...s.messagesByChat,
        [chatId]: [...(s.messagesByChat[chatId] ?? []), userMessage],
      },
      streamingByChat: { ...s.streamingByChat, [chatId]: "" },
      streamingPillsByChat: { ...s.streamingPillsByChat, [chatId]: [] },
      busyByChat: { ...s.busyByChat, [chatId]: true },
      error: null,
    }));

    // Phase 15 — if voice mode is active, route the FINAL reply
    // through the TTS speaker.
    //
    // Phase 15.1 changed how this works: we no longer feed
    // sentences mid-stream. Long replies were turning into "listen
    // to audio for hours" sessions, so we now wait until the turn
    // completes, ask the server for a spoken (possibly summarized)
    // version, and feed *that* to the speaker. Chat still shows
    // the full reply unchanged.
    const speaker = get().voice.lastInputWasVoice ? getSpeaker() : null;
    // Capture the speaker's generation at the start of the turn.
    // If the user re-arms the mic while we're awaiting the spoken
    // version, generation advances and we'll drop the stale audio
    // instead of talking over their new recording session.
    const speakerGenAtStart = speaker?.getGeneration() ?? 0;
    if (speaker) {
      speaker.onIdle(() => {
        const cur = get().voice;
        if (cur.state === "speaking") {
          set({ voice: { ...cur, state: "idle" } });
        }
      });
    }
    try {
      await api.sendMessage(scope, chatId, trimmed, {
        onChunk: (delta) => {
          set((s) => ({
            streamingByChat: {
              ...s.streamingByChat,
              [chatId]: (s.streamingByChat[chatId] ?? "") + delta,
            },
          }));
          // Phase 15.1 — no mid-stream speaker.update; we fetch the
          // spoken version once at onDone instead.
        },
        onPill: (pill) => {
          set((s) => {
            const current = s.streamingPillsByChat[chatId] ?? [];
            const idx = current.findIndex((p) => p.id === pill.id);
            const next = idx >= 0
              ? current.map((p, i) => (i === idx ? pill : p))
              : [...current, pill];
            return {
              streamingPillsByChat: { ...s.streamingPillsByChat, [chatId]: next },
            };
          });
          // If a project mutation just landed, refresh local project state so
          // counts/lists reflect reality without waiting for a manual reload.
          if (pill.phase === "applied") {
            void get().refreshProjects();
            const view = get().view;
            if (view.kind === "project") {
              void get().refreshProjectDetail(view.slug);
              void get().refreshFeatures(view.slug);
              void get().refreshFlows(view.slug);
              void get().refreshTasks(view.slug);
              if (view.tab === "activity") void get().refreshActivity();
            }
          }
        },
        onDone: ({ user, assistant }) => {
          set((s) => {
            const existing = s.messagesByChat[chatId] ?? [];
            const withoutOptimistic = existing.filter((m) => m.id !== userMessage.id);
            const merged = [...withoutOptimistic, user, assistant];
            const { [chatId]: _drop, ...restPills } = s.streamingPillsByChat;
            return {
              messagesByChat: { ...s.messagesByChat, [chatId]: merged },
              streamingByChat: { ...s.streamingByChat, [chatId]: "" },
              streamingPillsByChat: restPills,
              busyByChat: { ...s.busyByChat, [chatId]: false },
              chatsByScope: {
                ...s.chatsByScope,
                [key]: bumpSummary(s.chatsByScope[key] ?? [], chatId, user.text),
              },
            };
          });
          if (speaker) {
            // Phase 15.1 — fetch the spoken (possibly summarized)
            // version of the canonical assistant text and feed
            // *that* to the speaker. Short replies come back
            // unchanged (passthrough); long replies come back as
            // a ≤3-sentence summary; on summary failure the
            // server falls back to a deterministic truncate.
            //
            // Failure-resilient: if the endpoint itself errors
            // we fall back to speaking the original text via the
            // speaker's own splitter, so we never leave the user
            // in "voice mode" without audio feedback.
            void (async () => {
              const reset = () =>
                set((s) => ({ voice: { ...s.voice, lastInputWasVoice: false } }));
              try {
                const result = await api.getSpokenForText(assistant.text);
                // Generation guard — user may have re-armed the
                // mic during the fetch. Don't talk over their
                // new recording session.
                if (speaker.getGeneration() !== speakerGenAtStart) {
                  reset();
                  return;
                }
                if (!result.spoken_text) {
                  // Empty spoken text (e.g. assistant returned
                  // pure code that stripped to nothing). No
                  // audio to play; don't sit in "speaking".
                  const v = get().voice;
                  if (v.state === "speaking") {
                    set({ voice: { ...v, state: "idle" } });
                  }
                  reset();
                  return;
                }
                // Flip UI to "speaking" right before audio kicks
                // off so the mic button updates as soon as the
                // first sentence is queued.
                const v = get().voice;
                if (v.state !== "speaking") {
                  set({ voice: { ...v, state: "speaking" } });
                }
                await speaker.update(result.spoken_text);
                reset();
              } catch (err) {
                console.error("[voice] spoken_for_text failed:", err);
                // Last-ditch: try the original text. The speaker's
                // splitter still strips markdown, so worst case
                // the user hears the full reply (the old behavior).
                if (speaker.getGeneration() === speakerGenAtStart) {
                  try {
                    const v = get().voice;
                    if (v.state !== "speaking") {
                      set({ voice: { ...v, state: "speaking" } });
                    }
                    await speaker.update(assistant.text);
                  } catch {
                    /* ignore — surfaced via console above */
                  }
                }
                reset();
              }
            })();
          }
        },
        onError: (message) => {
          set((s) => {
            const { [chatId]: _drop, ...restPills } = s.streamingPillsByChat;
            return {
              busyByChat: { ...s.busyByChat, [chatId]: false },
              streamingByChat: { ...s.streamingByChat, [chatId]: "" },
              streamingPillsByChat: restPills,
              error: message,
            };
          });
        },
      }, undefined, getClientId());
    } catch (err) {
      set((s) => {
        const { [chatId]: _drop, ...restPills } = s.streamingPillsByChat;
        return {
          busyByChat: { ...s.busyByChat, [chatId]: false },
          streamingByChat: { ...s.streamingByChat, [chatId]: "" },
          streamingPillsByChat: restPills,
          error: err instanceof Error ? err.message : "request failed",
        };
      });
    }
  },

  // ---- Activity ----
  async refreshActivity() {
    const view = get().view;
    if (view.kind !== "project") return;
    const slug = view.slug;
    try {
      const entries = await api.getProjectActivity(slug);
      const key = scopeKey({ kind: "project", slug });
      set((s) => ({ activityByScope: { ...s.activityByScope, [key]: entries } }));
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "failed to load activity" });
    }
  },

  // ---- Features / Flows / Tasks ----
  async refreshFeatures(slug) {
    try {
      const features = await api.listFeatures(slug);
      set((s) => ({ featuresBySlug: { ...s.featuresBySlug, [slug]: features } }));
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "failed to load features" });
    }
  },
  async refreshFlows(slug) {
    try {
      const flows = await api.listFlows(slug);
      set((s) => ({ flowsBySlug: { ...s.flowsBySlug, [slug]: flows } }));
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "failed to load flows" });
    }
  },
  async refreshTasks(slug) {
    try {
      const tasks = await api.listTasks(slug);
      set((s) => ({ tasksBySlug: { ...s.tasksBySlug, [slug]: tasks } }));
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "failed to load tasks" });
    }
  },
  selectFeature(slug, featureId) {
    set((s) => ({
      selectedFeatureBySlug: { ...s.selectedFeatureBySlug, [slug]: featureId },
    }));
    if (featureId) void get().refreshCouncilRuns(slug, featureId);
  },
  highlightTask(slug, taskId, ttlMs = 5000) {
    set((s) => ({
      highlightedTaskBySlug: { ...s.highlightedTaskBySlug, [slug]: taskId },
    }));
    // Cancel any pending auto-clear timer for this slug — back-to-back
    // nav events should each get their own full TTL window.
    const prev = highlightTaskTimers.get(slug);
    if (prev) clearTimeout(prev);
    if (taskId === null) {
      highlightTaskTimers.delete(slug);
      return;
    }
    const handle = setTimeout(() => {
      highlightTaskTimers.delete(slug);
      const cur = useChatStore.getState().highlightedTaskBySlug[slug];
      // Don't clobber a newer highlight that landed during the wait.
      if (cur === taskId) {
        useChatStore.setState((s) => ({
          highlightedTaskBySlug: { ...s.highlightedTaskBySlug, [slug]: null },
        }));
      }
    }, ttlMs);
    highlightTaskTimers.set(slug, handle);
  },

  async refreshCouncilRuns(slug, featureId) {
    try {
      const runs = await api.listCouncilRuns(slug, featureId);
      const key = `${slug}::${featureId}`;
      set((s) => ({ councilRunsByFeature: { ...s.councilRunsByFeature, [key]: runs } }));
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "failed to load council runs" });
    }
  },

  async refreshQueue() {
    try {
      const queue = await api.getQueue();
      // If a new run started, reset the live tail buffer; the WS deltas
      // for this task will rebuild it.
      const prevTaskId = get().queue.current?.task_id;
      const nextTaskId = queue.current?.task_id;
      if (prevTaskId !== nextTaskId) {
        set({ runningTaskTail: queue.current?.output_tail ?? "" });
      }
      set({ queue });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "failed to load queue" });
    }
  },
  async refreshQuestions(slug) {
    try {
      const questions = await api.listQuestions(slug);
      set((s) => ({ questionsBySlug: { ...s.questionsBySlug, [slug]: questions } }));
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "failed to load questions" });
    }
  },
  async refreshArchitecture(slug) {
    try {
      const arch = await api.getArchitecture(slug);
      set((s) => ({ architectureBySlug: { ...s.architectureBySlug, [slug]: arch } }));
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "failed to load architecture" });
    }
  },
  async applyAndRefresh(envelope, slugForRefresh) {
    try {
      const res = await api.applyMutation(envelope);
      if (!res.ok) {
        set({ error: res.error ?? "mutation failed" });
        return false;
      }
      // Refresh whatever scope the mutation could have touched. Cheap to do
      // it eagerly — three small JSON GETs.
      const env = envelope as { kind?: string; payload?: { project_slug?: string } };
      const slug = slugForRefresh ?? env.payload?.project_slug;
      if (slug) {
        void get().refreshFeatures(slug);
        void get().refreshFlows(slug);
        void get().refreshTasks(slug);
        void get().refreshProjectDetail(slug);
      }
      // Tools / cron mutations bypass the project-slug branch entirely.
      const kind = env.kind ?? "";
      if (
        kind === "create_tool" ||
        kind === "update_tool" ||
        kind === "archive_tool"
      ) {
        void get().refreshTools();
      }
      if (
        kind === "create_cron" ||
        kind === "update_cron" ||
        kind === "archive_cron" ||
        kind === "set_cron_enabled" ||
        kind === "run_cron_now"
      ) {
        void get().refreshCronJobs();
      }
      // run_tool also creates a task → refresh tasks for the target project.
      if (kind === "run_tool") {
        const target = (envelope as { payload?: { project_slug?: string } }).payload;
        if (target?.project_slug) {
          void get().refreshTasks(target.project_slug);
          void get().refreshQueue();
        }
      }
      // Phase 13: any tool-proposal mutation refreshes the suggestion
      // queue. Accept also creates a Tool, so refresh tools too.
      if (
        kind === "propose_tool" ||
        kind === "accept_tool_proposal" ||
        kind === "reject_tool_proposal"
      ) {
        void get().refreshToolProposals();
        if (kind === "accept_tool_proposal") void get().refreshTools();
      }
      // Phase 14: any persona mutation flips the council's resolved
      // lens panel — refresh both the registry caches and the
      // resolved view for the active scope.
      if (
        kind === "create_persona" ||
        kind === "update_persona" ||
        kind === "archive_persona"
      ) {
        const payload = (envelope as { payload?: {
          scope?: { kind: "global" } | { kind: "project"; project_slug: string };
        } }).payload;
        const scope = payload?.scope;
        if (scope?.kind === "global") {
          void get().refreshGlobalPersonas();
        } else if (scope?.kind === "project") {
          void get().refreshProjectPersonas(scope.project_slug);
        } else {
          void get().refreshGlobalPersonas();
          const v = get().view;
          if (v.kind === "project") void get().refreshProjectPersonas(v.slug);
        }
        // Always refresh the resolved view for the active scope so
        // the council preview UI reflects the change.
        const v = get().view;
        if (v.kind === "project") void get().refreshResolvedPersonas(v.slug);
        else void get().refreshResolvedPersonas();
      }
      // Phase 12: rule mutations carry an explicit scope; refresh the
      // matching list so the panels update without manual reload.
      if (
        kind === "create_rule" ||
        kind === "update_rule" ||
        kind === "archive_rule" ||
        kind === "set_rule_enabled"
      ) {
        const payload = (envelope as { payload?: {
          scope?: { kind: "global" } | { kind: "project"; project_slug: string };
        } }).payload;
        const scope = payload?.scope;
        // create_rule has scope on payload; update/archive/set_enabled
        // may omit scope, in which case we conservatively refresh both
        // global rules and the rules for the project we're currently
        // viewing.
        if (scope?.kind === "global") {
          void get().refreshGlobalRules();
        } else if (scope?.kind === "project") {
          void get().refreshProjectRules(scope.project_slug);
        } else {
          void get().refreshGlobalRules();
          const view = get().view;
          if (view.kind === "project") void get().refreshProjectRules(view.slug);
        }
      }
      return true;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "mutation failed" });
      return false;
    }
  },

  async refreshTools() {
    try {
      const tools = await api.listTools();
      set({ tools });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "failed to load tools" });
    }
  },
  async refreshCronJobs() {
    try {
      const cronJobs = await api.listCronJobs();
      set({ cronJobs });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "failed to load cron jobs" });
    }
  },

  // ---- Voice (Phase 15) ----
  async refreshVoiceHealth() {
    try {
      const health = await api.getVoiceHealth();
      // Server-side availability is necessary but not sufficient —
      // also gate on the browser exposing MediaRecorder + Audio.
      const clientOk = voiceClientSupported();
      const userDisabled = Boolean(health.disabled_by_user);
      const reason = !clientOk
        ? "voice not supported on this device/browser"
        : userDisabled
          ? "voice disabled by user"
          : !health.stt.ok
            ? `stt: ${health.stt.reason ?? "unhealthy"}`
            : !health.tts.ok
              ? `tts: ${health.tts.reason ?? "unhealthy"}`
              : undefined;
      set((s) => ({
        voice: {
          ...s.voice,
          available: clientOk && health.available,
          userDisabled,
          healthReason: reason,
        },
      }));
    } catch (err) {
      set((s) => ({
        voice: {
          ...s.voice,
          available: false,
          healthReason: err instanceof Error ? err.message : "voice health probe failed",
        },
      }));
    }
  },

  // ---- Model selection (Phase 20) ----
  async refreshModelSettings() {
    try {
      const m = await api.getModelSettings();
      set({ models: { chat: m.chat, agent: m.agent, loaded: true } });
    } catch {
      // Non-fatal: leave whatever we already had. The Settings tab
      // shows a "couldn't load — retry" affordance via `loaded`
      // staying false on first load only.
    }
  },

  async voiceArm() {
    const v = get().voice;
    if (!v.available) return;
    if (v.state === "recording") return;
    // Cancel any in-flight playback so we don't talk over the user.
    // Also clear any pending transcript — re-arming after a preview
    // is the "talk to change it" path; the new utterance replaces
    // whatever was held. (User can keep the previous text instead by
    // editing it inline + hitting send.)
    getSpeaker().cancel();
    try {
      await getRecorder().start();
      set((s) => ({
        voice: {
          ...s.voice,
          state: "recording",
          pendingTranscript: null,
          error: null,
        },
      }));
    } catch (err) {
      set((s) => ({
        voice: {
          ...s.voice,
          state: "idle",
          error: err instanceof Error ? err.message : "mic permission denied",
        },
      }));
    }
  },
  async voiceStopAndPreview() {
    const v = get().voice;
    if (v.state !== "recording") return;
    set((s) => ({ voice: { ...s.voice, state: "transcribing", error: null } }));
    let result: { blob: Blob; contentType: string; durationMs: number };
    try {
      result = await getRecorder().stop();
    } catch (err) {
      set((s) => ({
        voice: {
          ...s.voice,
          state: "idle",
          error: err instanceof Error ? err.message : "recording failed",
        },
      }));
      return;
    }
    let transcript: string;
    try {
      const resp = await api.transcribeAudio(result.blob, {
        filename: `rec-${Date.now()}.webm`,
      });
      transcript = (resp.text ?? "").trim();
    } catch (err) {
      set((s) => ({
        voice: {
          ...s.voice,
          state: "idle",
          error: err instanceof Error ? err.message : "transcription failed",
        },
      }));
      return;
    }
    if (!transcript) {
      // Empty transcript — drop back to idle with a friendly hint
      // rather than landing in a `pending` state with no content.
      set((s) => ({
        voice: {
          ...s.voice,
          state: "idle",
          pendingTranscript: null,
          error: "didn't catch that — try again?",
        },
      }));
      return;
    }
    // Hand control back to the user. They can:
    //   - Hit "send" → voiceConfirmAndSend → fires the chat send.
    //   - Hit the mic again → voiceArm clears this transcript and
    //     starts a fresh recording (replaces).
    //   - Edit the textbox in the bubble → voiceEditPending.
    //   - Hit ✕ → voiceDiscardPending.
    set((s) => ({
      voice: {
        ...s.voice,
        state: "pending",
        pendingTranscript: transcript,
        error: null,
      },
    }));
  },
  voiceEditPending(text) {
    const v = get().voice;
    // Allow editing in any state where a pending transcript could
    // exist; a stray edit while idle is harmless and just stages the
    // text for the next confirm.
    if (v.state !== "pending") return;
    set((s) => ({
      voice: { ...s.voice, pendingTranscript: text },
    }));
  },
  async voiceConfirmAndSend() {
    const v = get().voice;
    if (v.state !== "pending") return;
    const transcript = (v.pendingTranscript ?? "").trim();
    if (!transcript) {
      set((s) => ({
        voice: {
          ...s.voice,
          state: "idle",
          pendingTranscript: null,
          error: "transcript is empty — record again or type something",
        },
      }));
      return;
    }
    // Phase 15.2 — voice routing. If the user previously locked the
    // target to a specific question (via QuestionsTab's SPEAK
    // button), the confirmed transcript fires an `answer_question`
    // mutation instead of becoming a chat message. Always reset
    // target back to `chat` after — a stale target redirecting a
    // future utterance is a real footgun.
    if (v.target.kind === "question") {
      const target = v.target;
      // Reset state immediately so the UI doesn't sit in `pending`
      // while the mutation is in flight. lastInputWasVoice stays
      // false here: the answer goes to disk, not back through chat;
      // there's no assistant turn to speak. (If a downstream task
      // later resumes via the queue, that's its own voice loop.)
      set((s) => ({
        voice: {
          ...s.voice,
          state: "idle",
          pendingTranscript: null,
          error: null,
          lastInputWasVoice: false,
          target: { kind: "chat" },
        },
      }));
      const ok = await get().applyAndRefresh(
        {
          kind: "answer_question",
          payload: {
            project_slug: target.project_slug,
            question_id: target.question_id,
            answer: transcript,
          },
        },
        target.project_slug,
      );
      if (!ok) {
        // Surface the mutation error in the same banner the rest
        // of the voice flow uses.
        set((s) => ({
          voice: {
            ...s.voice,
            error: "couldn't submit answer — try again or use the text reply",
          },
        }));
      }
      return;
    }

    // Default: route to chat. Flip `lastInputWasVoice` BEFORE send
    // so the streaming chunks route through TTS playback. State
    // drops to idle here; the streaming path will flip to
    // `speaking` once the spoken summary arrives.
    set((s) => ({
      voice: {
        ...s.voice,
        state: "idle",
        pendingTranscript: null,
        error: null,
        lastInputWasVoice: true,
      },
    }));
    await get().send(transcript);
  },
  voiceDiscardPending() {
    set((s) => ({
      voice: {
        ...s.voice,
        state: "idle",
        pendingTranscript: null,
        error: null,
        // Don't flip lastInputWasVoice — the user explicitly bailed,
        // so a future typed turn shouldn't get spoken.
        lastInputWasVoice: false,
        // Drop any locked question target — the user bailed, so a
        // future utterance shouldn't auto-route to a question they
        // walked away from.
        target: { kind: "chat" },
      },
    }));
  },
  voiceCancel() {
    getRecorder().cancel();
    getSpeaker().cancel();
    set((s) => ({
      voice: {
        ...s.voice,
        state: "idle",
        pendingTranscript: null,
        lastInputWasVoice: false,
        error: null,
        target: { kind: "chat" },
      },
    }));
  },
  setVoiceState(next) {
    set((s) => ({ voice: { ...s.voice, ...next } }));
  },
  async speakQuestion(question) {
    const v = get().voice;
    if (!v.available) {
      set((s) => ({
        voice: {
          ...s.voice,
          error: "voice unavailable — check VOICE_*_URL on the server",
        },
      }));
      return;
    }
    // Stop any in-flight audio / recording. New question = fresh
    // turn; we don't want yesterday's playback bleeding into this.
    getSpeaker().cancel();
    getRecorder().cancel();
    set((s) => ({
      voice: {
        ...s.voice,
        state: "speaking",
        pendingTranscript: null,
        error: null,
        lastInputWasVoice: false,
        target: {
          kind: "question",
          question_id: question.id,
          project_slug: question.project_slug,
          // Truncate the preview defensively — the banner only has
          // room for ~200 chars, anything longer just gets clipped
          // visually anyway.
          preview: question.body.slice(0, 200),
        },
      },
    }));
    // Reinstall the onIdle hook every time — speaker.cancel() above
    // already cleared any prior callback path, but we want to be
    // explicit. When the queue drains we drop back to `idle` so
    // the mic button reads "TALK" and the user can record an
    // answer; the locked question target stays put.
    const speaker = getSpeaker();
    speaker.onIdle(() => {
      const cur = get().voice;
      if (cur.state === "speaking") {
        set({ voice: { ...cur, state: "idle" } });
      }
    });
    try {
      await speaker.update(question.body);
    } catch (err) {
      // Defensive — speaker.update is supposed to swallow its own
      // errors (split/synthesize log + bail), but if something
      // really did throw we don't want the UI stuck in "speaking".
      console.error("[voice] speakQuestion failed:", err);
      set((s) => ({
        voice: {
          ...s.voice,
          state: "idle",
          error: "couldn't read the question aloud",
        },
      }));
    }
  },
  clearVoiceTarget() {
    set((s) => ({
      voice: { ...s.voice, target: { kind: "chat" } },
    }));
  },

  async refreshGlobalRules() {
    try {
      const globalRules = await api.listGlobalRules();
      set({ globalRules });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "failed to load rules" });
    }
  },
  async refreshProjectRules(slug) {
    try {
      const rules = await api.listProjectRules(slug);
      set((s) => ({ rulesBySlug: { ...s.rulesBySlug, [slug]: rules } }));
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "failed to load project rules" });
    }
  },

  async refreshToolProposals() {
    try {
      const toolProposals = await api.listToolProposals();
      set({ toolProposals });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "failed to load tool proposals" });
    }
  },

  async refreshGlobalPersonas() {
    try {
      const globalPersonas = await api.listGlobalPersonas();
      set({ globalPersonas });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "failed to load personas" });
    }
  },
  async refreshProjectPersonas(slug) {
    try {
      const personas = await api.listProjectPersonas(slug);
      set((s) => ({ personasBySlug: { ...s.personasBySlug, [slug]: personas } }));
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "failed to load project personas" });
    }
  },
  async refreshResolvedPersonas(slug) {
    try {
      const personas = await api.listResolvedPersonas(slug);
      const key = slug ?? "__global";
      set((s) => ({
        resolvedPersonasBySlug: { ...s.resolvedPersonasBySlug, [key]: personas },
      }));
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "failed to load resolved personas" });
    }
  },
}));

function summarize(chat: Chat): ChatSummary {
  const { messages: _m, ...rest } = chat;
  return rest;
}

// Boot the queue snapshot once on module load so the ticker has data
// the moment the UI renders. Subsequent updates stream through WS events.
void useChatStore.getState().refreshQueue();
// Tools + cron load lazily when their global tab is opened, but eagerly
// fetch once so chat-driven tool runs (e.g. agents emitting `run_tool`)
// surface immediately when the user navigates to the Tools tab.
void useChatStore.getState().refreshTools();
void useChatStore.getState().refreshCronJobs();
// Phase 12: global rules ride along with tools/cron — they're cheap and
// they keep the Rules tab snappy when the user clicks over.
void useChatStore.getState().refreshGlobalRules();
// Phase 13: pending tool suggestions surface as a banner on the Tools
// tab and as a count badge on the global tab — fetch eagerly so the
// badge is accurate from first paint.
void useChatStore.getState().refreshToolProposals();
// Phase 14: load the global persona registry + the global resolved
// lens panel so the Personas tab is snappy on first click and other
// surfaces (council preview banner, lens labels) have data to lean on.
void useChatStore.getState().refreshGlobalPersonas();
void useChatStore.getState().refreshResolvedPersonas();
// Phase 15: probe voice availability once at startup. The result
// drives whether the floating mic button renders. Cheap (small JSON
// from each upstream) and fire-and-forget.
void useChatStore.getState().refreshVoiceHealth();

/**
 * Voice upstreams (especially TTS on a Jetson) often boot slower than the
 * first `/v1/voice/health` poll — we used to probe once at startup and stay
 * stuck on **VOICE OFFLINE** forever. Re-fetch periodically whenever voice
 * is not explicitly disabled so recovery happens automatically once STT/TTS
 * come up; maintenance polls also catch mid-session outages.
 */
const VOICE_HEALTH_POLL_MS = 20_000;
setInterval(() => {
  const v = useChatStore.getState().voice;
  if (v.userDisabled) return;
  void useChatStore.getState().refreshVoiceHealth();
}, VOICE_HEALTH_POLL_MS);
// Phase 20: load the per-role model selection so the Settings tab
// renders with the user's actual choices on first paint and the
// composer can surface "running on X" if we add that affordance
// later.
void useChatStore.getState().refreshModelSettings();

/**
 * Module-level WS subscription. Refreshes project + activity data whenever
 * the server broadcasts a `mutation_applied` event. This catches mutations
 * from other clients, curl, or schedulers in addition to the per-chat
 * pill flow above.
 */
subscribeEvents((ev) => {
  const state = useChatStore.getState();

  // Phase 15 — voice/chat-driven navigation. The agent emits a
  // `navigate` mutation; only the originating tab honors the
  // resulting WS event. We compare on `client_id` so a navigate
  // that fires while two tabs are open routes only to the one that
  // sent the chat.
  if (ev.type === "nav_request") {
    const e = ev as {
      client_id?: string;
      target:
        | { kind: "global"; tab?: string }
        | { kind: "project"; project_slug: string; tab?: string }
        | { kind: "feature"; project_slug: string; feature_id: string }
        | { kind: "task"; project_slug: string; task_id: string };
    };
    if (e.client_id && e.client_id !== getClientId()) return;
    const t = e.target;
    if (t.kind === "global") {
      state.selectGlobal((t.tab as GlobalTab) ?? "chat");
    } else if (t.kind === "project") {
      void state.selectProject(t.project_slug, (t.tab as ProjectTab) ?? "chat");
    } else if (t.kind === "feature") {
      void state.selectProject(t.project_slug, "features");
      // Pre-select the feature so Flows/Architecture views know which one
      // to highlight. selectProject is async but selectFeature is sync —
      // safe to call immediately; the projects fetch races, but feature
      // selection lives in its own slice.
      state.selectFeature(t.project_slug, t.feature_id);
    } else if (t.kind === "task") {
      void state.selectProject(t.project_slug, "tasks");
      // Transient "ping" so the user's eye lands on the right card
      // rather than the whole Kanban. Sticky-select doesn't make
      // sense here (Tasks isn't a single-selection surface), so we
      // auto-clear after a few seconds.
      state.highlightTask(t.project_slug, t.task_id);
    }
    return;
  }

  // Phase 19 — voice global toggle changed. Re-poll health
  // immediately so the sidebar pill + mic-button visibility flip
  // without waiting for the next periodic poll (5min cycle).
  if (ev.type === "voice_settings_changed") {
    void state.refreshVoiceHealth();
    return;
  }

  // Phase 20 — per-role model selection changed (chat/agent). Pull
  // the new selection so any open Settings tab dropdown reflects
  // it immediately (multi-tab and agent-driven flips both land
  // here).
  if (ev.type === "model_settings_changed") {
    void state.refreshModelSettings();
    return;
  }

  // Council lifecycle events: refresh runs for the touched feature so
  // pending → running → completed/failed transitions render in real time.
  if (
    ev.type === "council_run_pending" ||
    ev.type === "council_run_running" ||
    ev.type === "council_run_completed" ||
    ev.type === "council_run_failed"
  ) {
    const e = ev as { project_slug: string; feature_id: string };
    void state.refreshCouncilRuns(e.project_slug, e.feature_id);
    if (ev.type === "council_run_completed") {
      // task_planning materializes proposed tasks → refresh tasks list too.
      void state.refreshTasks(e.project_slug);
      void state.refreshFeatures(e.project_slug);
    }
    return;
  }

  // Queue lifecycle: any state-changing event refetches the snapshot so
  // the ticker stays in sync. Cheap (one tiny GET).
  if (
    ev.type === "queue_state_changed" ||
    ev.type === "task_started" ||
    ev.type === "task_progress" ||
    ev.type === "task_finished"
  ) {
    void state.refreshQueue();
    if (ev.type === "task_started") {
      // New task — clear the local tail buffer; deltas for THIS task will
      // refill it from scratch.
      useChatStore.setState({ runningTaskTail: "" });
    }
    if (ev.type === "task_finished") {
      const e = ev as { project_slug: string };
      void state.refreshTasks(e.project_slug);
      void state.refreshFeatures(e.project_slug);
      void state.refreshQuestions(e.project_slug);
    }
    return;
  }

  // Streaming output for the running task — append to the live tail
  // buffer. Cap to ~64 KB so memory doesn't grow unbounded on long runs.
  if (ev.type === "task_delta") {
    const delta = String((ev as { delta?: string }).delta ?? "");
    if (!delta) return;
    useChatStore.setState((s) => {
      const next = (s.runningTaskTail + delta).slice(-64_000);
      return { runningTaskTail: next };
    });
    return;
  }

  if (ev.type !== "mutation_applied") return;

  // Tools / cron mutations are global-scoped — refresh those caches
  // regardless of which view the user is currently looking at.
  const kindAny = (ev as { kind?: string }).kind ?? "";
  if (
    kindAny === "create_tool" ||
    kindAny === "update_tool" ||
    kindAny === "archive_tool"
  ) {
    void state.refreshTools();
  }
  if (
    kindAny === "create_cron" ||
    kindAny === "update_cron" ||
    kindAny === "archive_cron" ||
    kindAny === "set_cron_enabled" ||
    kindAny === "run_cron_now" ||
    kindAny.startsWith("cron_dispatched") ||
    kindAny === "cron_dispatch_failed"
  ) {
    void state.refreshCronJobs();
    if (kindAny.startsWith("cron_dispatched") || kindAny === "run_cron_now") {
      void state.refreshQueue();
    }
  }
  // Phase 13: tool-proposal mutations refresh the suggestions cache
  // for any client (including ones that didn't apply the mutation).
  // Accept also creates a Tool, so refresh tools too.
  if (
    kindAny === "propose_tool" ||
    kindAny === "accept_tool_proposal" ||
    kindAny === "reject_tool_proposal"
  ) {
    void state.refreshToolProposals();
    if (kindAny === "accept_tool_proposal") void state.refreshTools();
  }
  // Phase 14: persona mutations don't carry the scope on the broadcast
  // event, so we conservatively refresh both global and the project
  // we're currently viewing, plus the resolved view.
  if (
    kindAny === "create_persona" ||
    kindAny === "update_persona" ||
    kindAny === "archive_persona"
  ) {
    void state.refreshGlobalPersonas();
    if (state.view.kind === "project") {
      void state.refreshProjectPersonas(state.view.slug);
      void state.refreshResolvedPersonas(state.view.slug);
    } else {
      void state.refreshResolvedPersonas();
    }
  }
  // Phase 12: rule mutations broadcast as `mutation_applied` events;
  // event payload doesn't include the original envelope so we can't
  // tell global vs project at this layer. Conservatively refresh
  // global rules + the rules for whichever project is visible.
  if (
    kindAny === "create_rule" ||
    kindAny === "update_rule" ||
    kindAny === "archive_rule" ||
    kindAny === "set_rule_enabled"
  ) {
    void state.refreshGlobalRules();
    if (state.view.kind === "project") {
      void state.refreshProjectRules(state.view.slug);
    }
  }

  void state.refreshProjects();
  if (state.view.kind !== "project") return;

  const slug = state.view.slug;
  void state.refreshProjectDetail(slug);
  if (state.view.tab === "activity") void state.refreshActivity();

  // Map verb → which entity caches need a refetch. We're cheap and refresh
  // the relevant slice rather than the whole project, but we don't try to
  // be surgical at the per-row level.
  const kind = (ev as { kind?: string }).kind;
  if (!kind) return;
  if (kind.endsWith("_feature") || kind === "approve_flow" || kind === "request_flow_review" || kind === "request_flow_changes" || kind === "request_task_planning" || kind === "approve_tasks") {
    void state.refreshFeatures(slug);
    const selected = state.selectedFeatureBySlug[slug];
    if (selected) void state.refreshCouncilRuns(slug, selected);
  }
  if (kind.includes("flow")) {
    void state.refreshFlows(slug);
    void state.refreshFeatures(slug);
  }
  if (kind.endsWith("_task") || kind === "approve_tasks") {
    void state.refreshTasks(slug);
    void state.refreshFeatures(slug);
  }
  if (kind === "enqueue_question" || kind === "answer_question" || kind === "dismiss_question") {
    void state.refreshQuestions(slug);
    void state.refreshTasks(slug);
  }
  if (kind === "start_queue" || kind === "pause_queue" || kind === "stop_queue" || kind === "start_task") {
    void state.refreshQueue();
  }
  if (
    kind === "add_service" ||
    kind === "update_service" ||
    kind === "remove_service" ||
    kind === "add_arch_edge" ||
    kind === "remove_arch_edge"
  ) {
    void state.refreshArchitecture(slug);
  }
});

function bumpSummary(chats: ChatSummary[], id: string, firstUserText: string): ChatSummary[] {
  const idx = chats.findIndex((c) => c.id === id);
  if (idx < 0) return chats;
  const current = chats[idx];
  const updated: ChatSummary = {
    ...current,
    title:
      current.messageCount === 0
        ? firstUserText.slice(0, 60).trim() || current.title
        : current.title,
    messageCount: current.messageCount + 2,
    updatedAt: Date.now(),
  };
  return [updated, ...chats.filter((_, i) => i !== idx)];
}
