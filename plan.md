# icarus plan

> "OpenHands / Devin / open-Claude, but built on `cursor-agent`, runnable from
> my phone." That's the shape of the thing.

## Vision

Replace Cursor Desktop on mobile. One web app where you:

- **Chat** with an LLM (we already have this) that can do things — create
  projects, file tasks, edit features — by emitting structured commands
  inside its responses.
- **Manage** a fleet of projects, each tied to a real codebase on disk. Tasks,
  features, flows, and architecture live as JSON next to the code.
- **Plan before you code.** Every feature must have an approved flow before
  tasks can exist. The Council helps design and review the flow. Agents only
  execute tasks the Council generated against an approved flow.
- **Browse** each project's source tree from the UI to see what the agent is
  actually touching.
- **Press "go"** and have a `cursor-agent` worker churn through your prioritized
  task queue across all projects, asking you questions only when it's stuck.
- **Resume any chat** later — chats are persisted, not session-scoped. Every
  conversation lives on disk and can be reopened from the sidebar.
- **Reusable tools and cron** (later phases) so the system can run scheduled
  work and call into named "skills" the way OpenHands/Open-Devin does — but
  here every tool is just a prompted `cursor-agent` invocation against a
  project workspace.

Web-first, mobile-friendly. Native polish later.

An earlier private prototype had most of the *plumbing* for this but
never wired up the brain. We lift the plumbing and build the brain.
Specifically: the brain isn't another LLM backend — it's `cursor-agent`
driven by structured prompts that emit commands and code edits. Our
server is a small command bus + state store + UI host.

---

## Architecture in one picture (in words)

```
                +----------------------------------+
                |          icarus app (web)        |
                |  global chat | per-project chat  |
                |  Kanban | features | flows | code|
                +----------------------------------+
                              ^   |
              SSE chunks      |   | HTTP (mutations) + WS (live)
                              |   v
+-------------------------------------------------------+
|                     icarus server                     |
|  - command parser (parses ```icarus blocks)           |
|  - mutation applicator (slug-dir JSON writers)        |
|  - per-project locks                                  |
|  - cross-project priority queue + worker loop         |
|  - WebSocket fanout                                   |
+-------------------------------------------------------+
                              |
                              v
                        cursor-agent CLI
        (one chat session per chat ID; one run per task)
```

- The LLM never directly mutates state. It speaks commands, our server
  applies them.
- `cursor-agent` does everything LLM-shaped: chat replies, code edits inside
  the project workspace, follow-up runs.
- The store is just JSON files on disk plus a small fleet index. No DB.

---

## Two chats

### Global chat
- Lives at the root of the app. The thing we already have.
- Knows about every project. System prompt is stuffed at chat start with:
  - The fleet (project list with one-line summaries)
  - The aggregate task counts per project
  - The N most recent mutations (so it remembers context across short gaps)
- Can emit any command in the vocabulary — including ones that create new
  projects.
- Workspace mounted at `/workspace` is the parent of all project folders, so
  it can `ls` to see them and read across them when needed.

### Per-project chat
- Lives inside a project's detail page.
- System prompt is stuffed with that project's `project.json`, current
  `features.json`, `tasks.json`, `flows.json`, `architecture.json`, plus
  a recent activity log.
- Workspace mounted at the project's `workspace_path` (so `cursor-agent`'s
  built-in tools — read, search, grep — work natively against that codebase).
- Commands in this chat default-target the project (no need to re-state the
  slug every time).

Both chats are just `cursor-agent` chat IDs (created via `cursor-agent
create-chat`, resumed each turn). We already have this infra.

### Chat persistence (new)
Chats are persisted to disk and reload on server restart. You can resume
any past chat from the sidebar.

**Source of truth split:**
- `cursor-agent` keeps the *LLM context* server-side, keyed by its chat id.
  Resuming a chat = `cursor-agent --resume <chat_id>`. We trust this.
- Icarus keeps the *rendered message log* on disk so the UI can render the
  conversation without re-querying cursor-agent, including action pills,
  question cards, and council-pass artifacts.

**Storage:**
```
store/
  chats/                          # global chats
    index.json                    # [{ id, title, created_at, last_active_at, cursor_chat_id, msg_count }]
    <chat_id>.json                # full message log + action pills
  <slug>/
    chats/                        # per-project chats, same shape
      index.json
      <chat_id>.json
```

**Per-message shape (sketch):**
```json
{
  "id": "msg_abc",
  "role": "user" | "assistant" | "system",
  "text": "...",
  "ts": "...",
  "action_pills": [{ "action": "create_task", "status": "applied", "result_id": "t_001" }],
  "question_card": { "question_id": "q_42", "task_id": "t_017", "body": "...", "status": "open" }?
}
```

**UI flow:**
- **Sidebar** lists all chats for the current scope (global at root,
  per-project on the project page). Newest at top, ordered by
  `last_active_at`.
- "+ New chat" creates a fresh `cursor-agent` chat id and a corresponding
  local file.
- Click a chat → server streams its message log; further sends use
  `--resume`.
- Auto-titling: first user message → first ~6 words → chat title. Manual
  rename available later. (Cheap LLM-titling later if it's a real itch.)
- Hard delete in v1 (rm the file + index entry). Soft archive later if we
  feel the loss.

**Recovery:** if cursor-agent's server-side context is ever missing for a
chat id (e.g. cursor-agent server data wiped), we fall back to re-priming:
new chat id, replay the local message log as a single context-stuffing
system prompt. Not v1 priority; capture as known-good behavior.

---

## Lifecycle gates (flow-first)

The whole point of icarus is to *plan before you code*. Features (and
optionally projects) move through gated states. Tasks can only exist for
features that have an approved flow. Agents can only be assigned tasks the
Council generated against an approved flow.

### Project lifecycle
```
draft → flowing? → active → archived
```
- Projects don't strictly need a top-level flow. They start `active` by
  default. `flowing` is optional — used when you want a "user journey" /
  "north star" flow at the project level before adding features.
- `archived` is reversible.

### Feature lifecycle (the strict path)
```
draft → flowing → flow_review → flow_approved → planning → planned → in_progress → done
       └────────────── council in the loop ──────────────┘    └ agents work tasks ┘
```
- **draft** — feature exists, has a name and description. No tasks allowed
  yet. UI shows a big "Design the flow" CTA.
- **flowing** — flow canvas is being built, conversationally in the
  per-feature/per-project chat. Council-flavored single agent helps draft
  nodes/edges by emitting `add_flow_node` / `add_flow_edge` commands. User
  accepts/rejects on the canvas.
- **flow_review** — user kicks off a formal **council pass** to critique the
  flow. 5 lenses (Product / UX / Architecture / Security / Operability) run in
  parallel, each returns a structured opinion (`approve` /
  `approve_with_notes` / `request_changes` with notes); a 6th chair pass
  synthesizes.
- **flow_approved** — all five lenses (or chair override) say approve. Flow
  is now blessed. Editing the flow after this point bumps the feature back
  to `flowing` and invalidates downstream tasks (they go to `stale` until
  re-blessed).
- **planning** — user kicks off **task generation council pass**. Council
  reads the approved flow + acceptance criteria and emits a draft task list
  via `add_task` commands tagged `proposed`. User can edit/remove before
  approving.
- **planned** — user approves the task list. Tasks become real (`status:
  todo`). The "go" loop will now pick them up.
- **in_progress** — at least one task is being worked or completed.
- **done** — all tasks reached `done`. Reversible (re-opening a task pulls
  the feature back to `in_progress`).

### Hard rules enforced by the mutation applicator
1. `add_task` with a `feature_id` is rejected unless that feature is in
   `planned`+ state. (Mutation rejected with a clear error; the chat
   schema-retry loop surfaces it back to the agent.)
2. `start_task` / `start_queue` will only pick up tasks whose parent feature
   is in `planned`+ (or tasks with no `feature_id` — see below).
3. `add_flow_node` / `add_flow_edge` move a feature from `draft` →
   `flowing` automatically.
4. `approve_flow` is gated on a successful council pass result.
5. Editing nodes/edges of an `flow_approved` feature transitions it back to
   `flowing` and marks all its tasks `stale`.
6. **Architecture gate** — `request_task_planning` is rejected unless the
   project's `architecture.json` has at least one service AND a current
   `approved_at` stamp. Any semantic edit on the architecture (services or
   edges, name / kind / description) auto-clears `approved_at` and re-blocks
   planning until the user re-approves. Position-only drags (x/y) on the
   canvas don't invalidate.

### Ad-hoc tasks (the escape hatch)
Tasks **without a `feature_id`** are allowed at the project level. Use them
for chores, bugs, "fix typo", "bump dep". They skip the flow gate entirely.
The "go" loop will work them too. Rationale: not every unit of work is a
feature; we don't want the gate to become a tax on small fixes.

---

## Command protocol (the "MCP")

Not actually MCP. The agent emits structured JSON inside its replies; the
server parses, validates, applies.

### Wire format
A command is a fenced JSON block tagged `icarus`:

````
```icarus
{ "action": "create_project", "payload": { "name": "Taxes" } }
```
````

Multiple commands per reply allowed (one per fence, or array per fence).

### System-prompt instruction (rough)
> When the user asks for something that changes icarus state — projects,
> features, tasks, flows, architecture — emit one or more ```icarus blocks
> alongside your conversational reply. Use exactly this schema: `{ "action":
> "<verb>", "payload": <object matching the action's schema> }`. Always reply
> conversationally too; the user will see your prose, not the JSON.

### Initial verb vocabulary
| action | scope | payload keys (sketch) |
| --- | --- | --- |
| `create_project` | global | name, workspace_path?, description? |
| `update_project` | global | slug, name?, description?, workspace_path? — `null` clears workspace_path; `"auto"` creates `$WORKSPACE_DIR/<slug>` |
| `archive_project` | global | slug |
| `add_feature` | project | project_slug, name, description?, priority? |
| `update_feature` | project | project_slug, feature_id, … |
| `add_flow_node` | project | project_slug, feature_id, node — auto-transitions feature to `flowing` |
| `add_flow_edge` | project | project_slug, feature_id, from_node_id?\|from_node_label?, to_node_id?\|to_node_label?, label? — labels resolve to most-recent matching node so chat agents can wire same-turn nodes |
| `update_flow_node` | project | project_slug, feature_id, node_id, patch |
| `remove_flow_node` | project | project_slug, feature_id, node_id |
| `request_flow_review` | project | project_slug, feature_id — kicks off council pass; transitions to `flow_review` |
| `approve_flow` | project | project_slug, feature_id — gated on council result; transitions to `flow_approved` |
| `request_task_planning` | project | project_slug, feature_id — gated on (a) feature in `flow_approved`, (b) project architecture has ≥1 service AND `approved_at` set; transitions to `planning` |
| `add_task` | project | project_slug, title, description?, feature_id?, priority?, depends_on?, acceptance_criteria? — rejected if `feature_id` is set and feature isn't `planned`+ |
| `approve_tasks` | project | project_slug, feature_id — turns proposed tasks into real `todo` tasks; transitions feature to `planned` |
| `update_task` | project | project_slug, task_id, … (status, priority, etc.) |
| `move_task` | project | project_slug, task_id, status |
| `add_service` / `update_service` / `remove_service` | project | service map verbs; any semantic edit auto-clears `approved_at` |
| `add_arch_edge` | project | project_slug, from_service_id?\|from_service_name?, to_service_id?\|to_service_name?, label?, kind? — same id-or-name pattern as `add_flow_edge` |
| `remove_arch_edge` | project | project_slug, edge_id |
| `approve_architecture` / `unapprove_architecture` | project | project_slug — sets/clears project-level `approved_at`; required to unlock `request_task_planning` |
| `set_service_note` | project | project_slug, service_id, note |
| `enqueue_question` | project | project_slug, task_id, question |
| `answer_question` | project | project_slug, question_id, answer |
| `start_queue` / `start_queue_for_project` / `start_task` | global / project | optional task ids; only picks up tasks whose parent feature is `planned`+ or tasks with no `feature_id` |
| `stop_queue` / `pause_queue` | global | — |
| `create_tool` / `update_tool` / `archive_tool` | global | name, slug?, description?, category?, prompt_template, params?: [{ name, type, label?, description?, required?, default?, options? }] — Phase 10 / 10.1 (slug auto-derived from name on create; unique among active tools; addressable at `/v1/tools/<slug>/run`) |
| `run_tool` | project (global registry) | tool_id, project_slug, args?, title?, priority?, auto_start? — creates a task carrying tool_id+tool_args; queue worker uses the tool's rendered template instead of the generic prompt |
| `propose_tool` | global | name, description?, category?, prompt_template, params?, rationale?, source: { kind: "chat"\|"task"\|"tool_run", project_slug?, chat_id?, message_id?, task_id? } — Phase 13 (agent-emitted; persists `pending` proposal; non-terminal so emit alongside the turn's terminal verb) |
| `accept_tool_proposal` | global | proposal_id, overrides?: { name?, slug?, description?, category?, prompt_template?, params? } — materializes the proposal into a real Tool by reusing `create_tool`, stamps `tool_id` on the proposal |
| `reject_tool_proposal` | global | proposal_id — soft-delete; idempotent for already-rejected, 409 for accepted |
| `create_cron` / `update_cron` | global | name, description?, schedule (5-field crontab), target: { kind: "tool", tool_id?\|tool_name?, project_slug, args?, priority? } \| { kind: "queue", project_slug? } \| { kind: "task", project_slug, title, description?, priority?, feature_id?, auto_start? }, enabled? — Phase 11 (task target added in Phase 11.1) |
| `archive_cron` / `set_cron_enabled` | global | cron_id (+ enabled for the latter) |
| `run_cron_now` | global | cron_id — fires the target right now, ignoring schedule |
| `create_rule` / `update_rule` | global or project | scope: { kind: "global" } \| { kind: "project", project_slug }; title, body, category?, enabled? — Phase 12 (free-form markdown prepended to every cursor-agent prompt in scope) |
| `archive_rule` / `set_rule_enabled` | global or project | rule_id, scope?, (enabled for the latter) — scope optional; falls back to id-scan when omitted |
| `create_persona` / `update_persona` | global or project | scope: { kind: "global" } \| { kind: "project", project_slug }; key, name, description?, prompt_template, accent? — Phase 14 (key matching a default lens replaces it; new key adds a lens) |
| `archive_persona` | global or project | persona_id, scope? — soft-delete; archived personas drop out of the council panel |
| `navigate` | global or project | target: { kind: "global", tab? } \| { kind: "project", project_slug, tab? } \| { kind: "feature", project_slug, feature_id } \| { kind: "task", project_slug, task_id }, reason? — Phase 15. Non-mutating; broadcasts a `nav_request` WS event scoped to the originating `client_id`. |

(Fully formal JSON Schema lives in `schemas/v0/icarus-command-v0.schema.json`
once we start coding. One schema, one source of truth — same pattern as the
source repo's mutation envelope, which we lift verbatim.)

### Streaming UX for command blocks
While the assistant is mid-stream, the ```icarus fence may be open with
partial JSON inside. The UI rule:

- Render text outside fences normally.
- For an open ```icarus fence: hide the JSON. Show a placeholder pill:
  `▶ preparing an action…`
- When the fence closes and the JSON parses + validates: pill becomes
  `✔ create_task — "Add login screen"`
- On schema fail: pill becomes `✗ command rejected: <reason>` and we trigger
  a self-correction (see retries).

### Schema-retry loop
LLMs will occasionally botch JSON. We don't show errors to the user mid-chat.
Algorithm:

1. Validate every parsed command. On failure, do not apply.
2. Append a system observation to the chat: `(system: command #N rejected —
   field "priority" must be one of [low,med,high]; please re-emit corrected
   command)`.
3. Re-resume the same `cursor-agent` chat id with that observation as the
   next prompt. Stream the new response in.
4. Cap at 2 retries per turn. After cap, surface a `✗ rejected (max retries)`
   pill and move on; the user can see and fix manually.

### Memory of applied actions
On the *user's* next turn, prepend a tiny system observation like:
`(system: last turn applied 2 actions: create_project slug=taxes-7f, add_task
task_id=t_001)`. Keeps the agent honest about state without burning a
round-trip per command.

---

## Storage layout

Lift wholesale from the source repo, with our additions for features.

```
${ICARUS_DATA:-./store}/
  fleet.json                     # { projects: [{ slug, name, workspace_path }] }
  chats/                         # global chats (persisted, see Chat persistence)
    index.json
    <chat_id>.json
  tools.json                     # { tools: [{ id, slug, name, prompt_template, … }] } — Phase 10 / 10.1
  cron.json                      # { jobs: [{ id, schedule, target, … }] } — Phase 11
  rules.json                     # { rules: [{ id, scope:"global", title, body, … }] } — Phase 12 (global rules)
  tool_proposals.json            # { proposals: [{ id, status, name, prompt_template, params?, rationale?, source, tool_id?, … }] } — Phase 13 (agent-emitted suggestions)
  personas.json                  # { personas: [{ id, scope:"global", key, name, prompt_template, … }] } — Phase 14 (global council personas)
  <slug>/
    project.json                 # display name, description, settings, status (active|archived)
    features.json                # { features: [{ id, name, description, status, priority, flow_id?, … }] }
    tasks.json                   # { tasks: [{ id, title, status, priority, feature_id?, proposed?:bool, depends_on?, … }] }
    flows.json                   # { flows: [{ id, feature_id, nodes:{}, edges:[], approved_at?, approved_by? }] }
    architecture.json            # { services:[…], edges:[…], updated_at, approved_at? } — approved_at gates request_task_planning
    rules.json                   # { rules: [{ id, scope:"project", project_slug, title, body, … }] } — Phase 12 (project rules)
    personas.json                # { personas: [{ id, scope:"project", project_slug, key, name, prompt_template, … }] } — Phase 14 (project-scoped council personas)
    chats/                       # per-project chats
      index.json
      <chat_id>.json
    council/
      <feature_id>/
        flow-review-<run_id>.json   # council run = 5 lens opinions + chair decision
        task-plan-<run_id>.json
    council.jsonl                # append-only summary index of council runs
    activity.jsonl               # append-only; every applied mutation, for chat context
    questions.json               # { questions: [{ id, task_id, body, status, answer?, chat_id?, msg_id? }] }
```

Each feature has at most one flow (1:1). The `flow_id` lives on the feature
record; the actual nodes/edges live in `flows.json` keyed by id. Council
runs are immutable artifacts — every flow review and every task planning
session leaves a record on disk you can scroll back through.

Notes:
- One project = one slug-dir. Mirrors the source repo's shape, easy
  inspection, easy to back up.
- `workspace_path` is the source code folder for that project, *separate*
  from the icarus store. Many of your projects already exist on disk; we
  point at them, don't copy.
- Each project folder also lives in `WORKSPACE_DIR` for cursor-agent
  visibility (already wired). Default mount is whatever you set
  `WORKSPACE_DIR` to in `.env` (e.g. `~/projects` or `~/work`), so
  most existing repos are addressable.

### Mutation envelope (single endpoint)
- `POST /v1/mutations/apply` — body is a `kind`-tagged envelope, validated
  against `schemas/v0/icarus-mutation-v0.schema.json`, dispatched to a
  per-kind applicator. Same pattern as the source repo (and same name) so
  the work translates 1:1.
- Per-project lock around every apply (lift `project-lock.js` style).
- Every successful apply appends a row to `activity.jsonl` and broadcasts
  over WebSocket.

Important separation: **commands** are what the LLM emits in chat;
**mutations** are what hit the apply endpoint. Most commands map 1:1 to a
mutation. They're separate vocabularies because we want commands to be
LLM-friendly (terse, action-named) and mutations to be infra-friendly
(versioned, schema'd, idempotent).

---

## Council (the planning brain)

Council shows up in **two flavors**, used at different points in the
lifecycle. The expensive one is used sparingly at gates; the cheap one is
the everyday flow-design assistant.

### Flavor 1 — "council-flavored" single agent (cheap, conversational)
- This is the agent powering the per-feature / per-project chat during the
  `flowing` state.
- One `cursor-agent` chat session, but its system prompt instructs it to
  reason across five lenses internally before responding: **Product**
  (user value), **Architect** (system fit), **Engineer** (feasibility),
  **UX** (interaction), **QA** (testability).
- It drafts flow nodes/edges by emitting `add_flow_node` / `add_flow_edge`
  commands as the user describes the feature.
- Used continuously while `flowing`. No extra cost beyond normal chat.

### Flavor 2 — formal council pass (gated, structured, advisory)
- Triggered explicitly at exactly two moments:
  1. **Flow review** — when the user thinks the flow is ready
     (`request_flow_review`).
  2. **Task planning** — once the flow is approved
     (`request_task_planning`).
- v1 implementation (cheap): **one `cursor-agent` run** with a Chair-style
  prompt that produces a structured 5-lens output and a consolidated
  verdict in a single response. Output schema:
  ```json
  {
    "lenses": {
      "product": { "verdict": "approve|request_changes", "notes": "...", "suggestions": [...] },
      "architect": { ... }, "engineer": { ... }, "ux": { ... }, "qa": { ... }
    },
    "chair": { "summary": "...", "must_address": [...], "nice_to_have": [...] },
    "tasks": [...]   // only for task-planning passes
  }
  ```
- v2 (Phase 9, alongside parallel workers): **5 parallel `cursor-agent`
  runs** + a separate Chair run. Same artifact shape, just genuinely
  independent opinions.
- **The council is advisory.** It never auto-applies `approve_flow` or
  `approve_tasks`. The user is *always* the final gate.
  - Flow review result → UI shows a verdict panel (5 lenses + Chair
    summary). User reads, hits "Approve flow" or "Request changes" (with
    notes) which sends the council back for another pass or returns to
    `flowing`.
  - Task planning result → tasks land as `proposed: true`. User edits /
    removes individual tasks in the "Proposed tasks" panel, then hits
    "Approve plan" (`approve_tasks`).
- No quorum logic. No 3/5 majority threshold. The user reads the verdicts
  and decides. The council is there to surface blind spots, not to vote.
- Every pass is persisted to `council/<feature_id>/<run-type>-<run_id>.json`
  so you can scroll back through the deliberation later.

### Why two flavors
Running 5 parallel agents on every chat turn during flow drafting would be
slow and expensive. Running a single agent at the formal gates would lose
the multi-perspective scrutiny that's the whole point of "council." Two
flavors gives you cheap-and-fast for iteration, structured-and-rigorous at
the moments that matter — and v1 keeps Flavor 2 cheap-ish too (one
multi-lens call) until we have a real reason to pay for parallelism.

---

## Questions (the agent → human escape hatch)

When an agent gets stuck on a task, it emits `enqueue_question`. We surface
that question two ways simultaneously, so it reaches you wherever you are.

### Inbox view (asynchronous)
- Per-project **Questions** tab lists open questions for that project's
  tasks.
- Global **Inbox** pane on the cockpit aggregates open questions across the
  fleet. Click one → jumps to the relevant project + chat.
- Each question shows: the task it's blocking, the question body, the time
  it was asked, and a Reply input. Submitting → `answer_question` mutation
  → the task transitions out of `blocked`.

### Inline chat injection (synchronous)
When `enqueue_question` is applied, the server *also* injects a special
message into the relevant chat (per-project chat for project tasks; global
chat for ad-hoc fleet-wide tasks):

```
┌──────────────────────────────────────────────────┐
│ ❓ Question from agent (task: "Wire up SSO")     │
│                                                  │
│ Should we use Google or Apple as the default IdP │
│ on the login screen? The flow shows both but...  │
│                                                  │
│ [ Reply to this question ]   [ Open in Inbox ]   │
└──────────────────────────────────────────────────┘
```

- Click "Reply" → the composer focuses with the question id tagged. Your
  next message is interpreted as `answer_question` for that specific
  question id (not as a normal chat turn).
- The question card persists in the chat log forever, so the conversation
  history shows the back-and-forth in context.
- If you ignore the inline card and answer from the Inbox instead, the
  card updates in place to show the answer + status `answered`.

### Why both
The inline injection means: if you happen to be chatting with the agent
about feature X, and a queue worker on feature Y blocks with a question,
the question still lands in front of you. The inbox means: if you're not
chatting, blockers don't get lost — the cockpit shows the count, and
clicking a question takes you to the right place.

---

## The autonomous loop ("go" mode)

This is what makes icarus more than a chat with a Kanban.

### Trigger
- User on the global chat says "go" / "work the queue" / "knock these out"
  (or hits a "▶ Run queue" button on the cockpit).
- That maps to one of three command verbs:
  - `start_queue` — entire fleet, priority-ordered.
  - `start_queue_for_project` — single project.
  - `start_task` — one specific task by id.

### What the worker does
A small loop (one process, in-server for v1):

1. Pick the highest-priority task that satisfies *all* of:
   - `status: todo`
   - all `depends_on` already in `done|verified`
   - either has no `feature_id` (ad-hoc/chore) **or** its parent feature is
     in `planned`+ state (i.e. the flow gate passed).
   Tie-break by `created_at`.
2. Mark it `in_progress`, set `claimed_by_session = "queue-runner"` (we lift
   the lease fields from their schema for this).
3. Spawn `cursor-agent --print --output-format stream-json --resume <chat>
   --mode agent --force --workspace <project.workspace_path>` with a
   structured prompt: task title + description + acceptance criteria +
   definition_of_done + system prompt explaining "you can emit
   ```icarus blocks if you need to ask a question or claim done."
4. Stream the run into a "live execution" pane in the project UI. Parse any
   commands the agent emits along the way (e.g. `enqueue_question`).
5. On agent completion:
   - If it ended with `complete_task` command → mark `done`.
   - If it ended with `enqueue_question` → set status `blocked`, surface the
     question to the user, move on to the next task.
   - If `cursor-agent` exited non-zero → status `error`, log to
     `activity.jsonl`, move on.
6. Repeat until queue empty or user says stop.

### Concurrency
- v1: **one task at a time across the whole fleet.** Boring, predictable.
- v2: per-project parallelism using the existing lease/heartbeat fields
  (`claimed_by_session`, `lease_heartbeat_ts`, `resource_scope`). Multiple
  workers, each claims, heartbeats. Already half-modelled in the source
  schema; we just wire the actual loop.

### Stop / pause / status
- `stop_queue`, `pause_queue` commands.
- WebSocket events on every state change: `task.claimed`, `task.heartbeat`,
  `task.completed`, `task.blocked`, `queue.idle`. UI shows a live ticker.

### Safety
- v1 is opt-in only — the loop runs only when explicitly started. No
  background autonomy.
- `--force` on cursor-agent is gated behind the project's
  `allow_file_writes` flag (defaults to true since you said "trust it"; can
  be toggled per project).
- Every task run is logged to `activity.jsonl` and a per-run log file.

---

## Click-ops UX (the cockpit)

For when chat is the wrong tool. All of these are also driveable via chat
commands so we never have a feature only one of them can do.

- **Sidebar**: project list (the fleet). Per-scope chat list under each
  selected project. "+ New chat", "+ New project".
- **Project page tabs**:
  - **Chat** — per-project chat (default tab). Sidebar lists this
    project's chats; "+ New chat" creates one.
  - **Tasks** — Kanban (todo / in_progress / blocked / done). Drag on web,
    tap-to-edit on mobile. Stale tasks badged + "Replan" button when a
    flow has been edited since approval.
  - **Features** — list view. Each card shows lifecycle state badge
    (draft / flowing / flow_review / flow_approved / planning / planned /
    in_progress / done) and links to its flow + tasks.
  - **Flows** — per-feature canvas (nodes + edges). Real edge editor.
    Approval CTA inline.
  - **Architecture** — service map (boxes + notes + edges).
  - **Code** — file tree of `workspace_path`. Click a file → read-only
    viewer with syntax highlighting. v2: editable.
  - **Questions** — open questions for this project's tasks. Reply inline
    or jump to the relevant chat.
  - **Activity** — `activity.jsonl` rendered as a feed.
- **Global cockpit** (root):
  - Global chat, full width on mobile.
  - Sidebar with global chats list.
  - "Run queue" floating button.
  - Live ticker of any running tasks across the fleet.
  - **Inbox** badge — count of unanswered questions across all projects.
    Click → fleet-wide questions list.

Mobile-first means: one pane at a time, drawer nav, bottom-anchored composer,
swipeable Kanban columns. Don't try to fit a desktop cockpit on a phone
screen — make it phone-shaped first, the desktop layout falls out for free.

---

## Phasing

The flow gate forces a re-ordering: council and flows are now on the
critical path *before* the "go" loop, because no feature task can exist
until the flow is approved. The first usable end-to-end version requires
phases 0–5.

### Phase 0 — Foundation (slug-dir store + mutation envelope + chat persistence)
- Storage layout above.
- `POST /v1/mutations/apply` with kind-dispatched applicators.
- Per-project locks.
- WebSocket fanout.
- `activity.jsonl` writer.
- JSON Schema for the mutation envelope, copied from theirs and trimmed to
  what we use in v1. Includes the lifecycle gate rules baked in (e.g.
  `add_task` rejects when feature isn't `planned`+).
- **Chat persistence**: refactor the in-memory chat store into a
  disk-backed one (`store/chats/` for global, `store/<slug>/chats/` later).
  Reload on startup, list in sidebar, resume any chat. Auto-title from
  first user message.

### Phase 1 — Projects + per-project chat
- Project create / list / archive (chat command + click-ops).
- Project detail page shell with the tab structure.
- Per-project chat wired (own chat id, project context in system prompt,
  workspace mounted to the project's `workspace_path`).
- Activity feed renders.

### Phase 2 — Command protocol on global + per-project chat ✅ shipped
- ✅ System prompt that teaches the model the command vocabulary
  (`server/src/commands/system_prompt.ts`, prepended to every user turn).
- ✅ Streaming parser that finds ```icarus fences in the assistant deltas
  (`server/src/commands/parser.ts`, line-anchored, handles
  cross-delta boundaries, char-by-char streaming, and a missing-trailing-newline
  closer at end of stream).
- ✅ Mid-stream "▶ preparing action" → "✔ applied" / "✕ rejected" pills,
  forwarded as `pill` SSE events and rendered inside the assistant
  bubble via `app/src/components/PillRow.tsx`. Pills are persisted with
  the assistant `Message` so they survive reload.
- ✅ Memory observation: applied mutations are stored as `pendingMemory`
  on the chat record and prepended to the *next* user turn so the agent
  knows what its previous reply actually changed (verified — the agent
  recalled the auto-assigned slug on turn 2).
- ✅ Bonus: `app/src/events.ts` subscribes to the `/v1/events` WS so
  every client live-refreshes projects + activity on `mutation_applied`,
  including mutations from other windows / curl / future schedulers.
- ✅ **Schema-retry loop** (`MAX_RETRIES = 3`). On every rejected pill,
  the server re-prompts the same cursor-agent session with the validation
  error and a directive ("re-emit ONLY the corrected blocks; do not
  repeat the ones that already applied; if the schema can't be
  satisfied, give up conversationally"). Retries stream inline with
  italic banners (`_[icarus] command rejected — auto-retrying (n/3)…_`)
  and a `retry_status` SSE event. When the budget burns out, a
  `MemoryEntry` with `outcome: "rejected_terminal"` is persisted on the
  chat — this is the hook the council will read in Phase 4 to surface
  the failure as an open question. Verified end-to-end: an agent looped
  on `kind=delete_universe` exhausted retries, the next turn's prompt
  surfaced the failure via the memory block, and the agent recapped it
  back to the user.

### Phase 3 — Features + flow canvas (read+draft, no approval yet) ✅ shipped
- ✅ Feature, Flow, Task domain types with full lifecycle states
  (`server/src/domain.ts`).
- ✅ Per-project lock'd reads/writes: `featuresFile`, `flowsFile`,
  `tasksFile` with atomic read-modify-write under `projectLocks`.
- ✅ Verbs: `add_feature` / `update_feature` / `archive_feature`,
  `add_flow_node` / `update_flow_node` / `remove_flow_node` /
  `add_flow_edge` / `remove_flow_edge`, `add_task` / `update_task`.
  All zod-validated; `add_task` enforces the lifecycle gate
  (feature must be `planned`+ for feature-attached, ad-hoc tasks
  always allowed).
- ✅ Read endpoints: `GET /projects/:slug/features|flows|tasks`;
  the project-detail GET expands them inline.
- ✅ Chat command vocabulary extended in
  `server/src/commands/system_prompt.ts`.
- ✅ Client UI: Features tab with "+ Add Feature" modal, drag-positioned
  Flow canvas (`FlowCanvas.tsx` — nodes + edges, click to add, drag to
  position), Tasks tab read-only for feature-attached, ad-hoc add
  allowed. Live-refreshes via WS on every relevant mutation.

### Phase 4 — Council + the flow → tasks pipeline ✅ shipped
This is the heart of the system. After this phase you can take a feature
from idea to a real, approved task list, all via chat or click-ops.

What's live:
- Council artifact shape (`server/src/council/types.ts`):
  `CouncilRun` { id, type: `flow_review`|`task_planning`, status:
  `pending`|`running`|`completed`|`failed`, started_at, finished_at,
  result, error, raw_text }, with strict `LensReport` × 5 + `ChairReport`
  for flow_review and `ProposedTask[]` + chair for task_planning.
- Disk-backed artifacts at
  `store/<slug>/council/<feature_id>/<run_type>-<run_id>.json`,
  written under the per-project lock. `listRuns` / `latestRun` /
  `loadRun` helpers in `server/src/council/storage.ts`.
- Single cursor-agent runner (v1 sequential) in
  `server/src/council/runner.ts` — one fresh chat per run, fenced JSON
  envelope extracted with a tolerant control-char escaper and zod
  validation. **One internal retry on JSON / schema failure** before
  the run is marked `failed`. WS events at every state transition
  (`council_run_pending` / `_running` / `_completed` / `_failed`).
- Verbs (`server/src/mutations/applicators.ts`):
  - `request_flow_review`: `flowing → flow_review`, queues runner,
    returns the pending run synchronously.
  - `approve_flow`: `flow_review|flowing → flow_approved` (skip-council
    escape hatch is allowed; council never auto-approves).
  - `request_flow_changes`: `flow_review → flowing` with optional notes.
  - `request_task_planning`: `flow_approved → planning`, queues runner.
    On completion, proposed tasks are materialized into `tasks.json`
    with `proposed: true` and `feature_id` set.
  - `approve_tasks { task_ids[] }`: `planning → planned`. Listed
    proposals flip `proposed: false`; un-listed proposals are dropped.
- **Stale-on-edit**: any flow mutation (`add/remove_flow_node`,
  `add/remove_flow_edge`, semantic `update_flow_node` on label/kind/
  description) on a feature past `flow_approved` bumps the feature back
  to `flowing` and marks all non-terminal feature-attached tasks
  `stale`. Pure position changes (drag the node around the canvas) do
  NOT trigger staleness.
- Read endpoints: `GET /projects/:slug/council/:feature_id` (list,
  optional `?type=`), `GET /.../:run_type/:run_id` (single artifact).
- Chat command vocabulary extended with the new verbs; `approve_flow`
  and `approve_tasks` carry an explicit "USER decides; do NOT call
  this on the user's behalf" instruction so the agent only proposes.
- Client UI:
  - `CouncilPanel` rail on the Flow canvas — shows the latest flow
    review run (chair card + 5-lens grid with severity dots, expand
    on tap), action buttons appropriate to the feature's current
    status (Request review / Approve / Request changes / Plan tasks /
    Approve without review), running/pending/failed states.
  - Tasks tab: `ProposedSection` per planning-state feature with a
    tap-to-drop UX and a single `APPROVE N` button.
  - Features tab: stale-task strip + `REPLAN` button on stale rows
    that drops the user into the flow canvas with the feature
    selected.
  - WS-driven live refresh on every council event.

### Phase 5 — The "go" loop (autonomous queue) + Questions ✅ shipped
- ✅ Queue domain types (`server/src/queue/types.ts`):
  `QueueState` { run: idle|running|paused, scope, changed_at, note },
  `RunningTask` { task_id, status, output_tail, pills, retries,
  blocking_question_id, … }, `Question` (open|answered|dismissed).
- ✅ Disk-backed `questions.json` + per-task run transcripts at
  `store/<slug>/task_runs/<task_id>-<run_id>.json`.
- ✅ Gate-aware cross-project picker (`server/src/queue/picker.ts`):
  filters out `proposed`, non-`todo`, blocked-by-open-question,
  and (Phase 9) leased tasks / colliding `resource_scope`. Sorts by
  priority desc, then created_at asc.
- ✅ `QueueWorker` (`server/src/queue/worker.ts`): drives
  `cursor-agent --force` in each project's `workspace_path`, parses
  `icarus` blocks via `FenceParser`, persists `TaskRunRecord` with the
  raw transcript + every applied/rejected pill.
- ✅ Verbs: `start_queue` / `pause_queue` / `stop_queue` / `start_task`
  (synchronous, bypasses queue state); terminal verbs
  `complete_task` / `fail_task` / `enqueue_question` plus user-side
  `answer_question` / `dismiss_question`.
- ✅ Read endpoints: `GET /queue`, `/queue/eligible`,
  `/projects/:slug/questions`, `/projects/:slug/tasks/:task_id/runs`.
  WS events: `queue_state_changed`, `task_started`, `task_progress`,
  `task_delta`, `task_finished`.
- ✅ Task-execution system prompt (`buildTaskExecutionPrompt`) with
  exactly-one-terminal-verb contract; rest of the chat vocabulary stays
  available (the agent can patch the project as it works).
- ✅ Client UI: `QueueTicker` (always-visible bottom strip, expands to
  full-screen modal with live transcript + per-slot chips when running
  > 1 task), `QuestionsTab` (open + resolved questions, inline reply or
  option chips, dismiss button), `TasksTab` "▶ RUN" button on eligible
  rows, store WS subscriptions that refresh `queue` / `tasks` /
  `questions` on the matching events.
- ✅ Backend smoke test (`server/scripts/smoke-phase5.sh`) drives the
  full lifecycle end-to-end and verifies the agent actually wrote files.

### Phase 6 — Tasks Kanban polish + features list polish ✅ shipped
- ✅ `TasksTab` row layout with state-tinted left edges, stale badge on
  `stale` tasks, and a "▶ RUN" button on eligible rows that calls
  `start_task` synchronously.
- ✅ Feature cards (`FeaturesTab` `FeatureRow`) gained a per-feature
  progress bar (done / total tasks) sourced from the live tasks slice.
- ✅ Stale-task strip + `REPLAN` button on stale rows (shipped as part
  of Phase 4 stale-on-edit) drops the user into the flow canvas with
  the feature pre-selected.

### Phase 7 — Code browser ✅ shipped (read-only)
- ✅ Server: `server/src/code/files.ts` — `listDir` + `readFile` with
  workspace path validation (rejects path traversal), filtering of
  hidden/heavy directories (`node_modules`, `.git`, `dist`, etc.),
  heuristic binary detection, and a 256 KB read cap with a `truncated`
  flag. Endpoints: `GET /projects/:slug/files?path=…` and
  `GET /projects/:slug/file?path=…`.
- ✅ Client: `CodeBrowser.tsx` — two-pane file tree + viewer with line
  numbers and inferred language label. Empty-workspace and binary-file
  states handled with friendly messages.
- ⏭️ **Deferred:** syntax highlighting and live diff highlighting during
  queue runs. Read-only viewer ships now; we revisit when the
  `cursor-agent` write stream is plumbed for diffs.

### Phase 8 — Architecture canvas ✅ shipped
- ✅ Domain types: `ArchService` (kind: service|datastore|external|
  client|job), `ArchEdge` (kind: request|event|sync|reads|writes),
  `Architecture` { services, edges, updated_at }. Stored as
  `store/<slug>/architecture.json`; `create_project` initializes an
  empty architecture so reads never hit a `null` shape.
- ✅ Verbs: `add_service` / `update_service` / `remove_service`
  (cascades incident edges) / `add_arch_edge` / `remove_arch_edge`,
  all zod-validated.
- ✅ Read endpoint: `GET /projects/:slug/architecture`.
- ✅ Client: `ArchitectureCanvas.tsx` — service list with kind icons,
  detail panel showing incoming/outgoing edges, modals for
  click-ops add (service / edge). Persists via the standard
  mutation envelope; live-refreshes on the WS `mutation_applied`
  event for any architecture verb.

### Phase 9 — Parallelism via leases + 5-parallel Council ✅ shipped
- ✅ `resource_scope` field on `Task` (zod-validated through
  `AddTaskPayload` / `UpdateTaskPayload`); the picker excludes any task
  whose scope is currently held by an active lease.
- ✅ `QueueWorker` is now multi-slot: `slots[]`, `slotChildren[]`,
  `slotBusy[]`, and a `leases` map keyed by `task_id`. `dispatchFreeSlots`
  is serialized by a coarse `pickerMutex` so two slots can't claim the
  same task. `maxParallel` defaults to 2, configurable via
  `ICARUS_QUEUE_PARALLELISM` (capped at 8). On task end the lease is
  released and the loop re-kicks to fill the slot.
- ✅ `QueueSnapshot` exposes both `current` (back-compat: first slot)
  and `running[]` (all slots). `QueueTicker` shows a "×N" badge when
  more than one task is in flight and lists per-slot chips inside the
  expanded modal.
- ✅ Single-process design: leases live in memory. On restart the queue
  boots `idle` and abandoned in-progress tasks stay marked
  in_progress until the user moves them. Heartbeats / cross-process
  reaping are intentionally deferred — not needed while the worker is
  in-process and we only need to coordinate between in-memory slots.
- ✅ Council runner refactored to true **5-parallel + chair**
  (`runFlowReviewParallel` in `server/src/council/runner.ts`). Each
  lens runs as its own `cursor-agent` one-shot via
  `buildFlowReviewLensPrompt`; once all 5 land, a 6th synthesis pass
  uses `buildFlowReviewChairPrompt`. Each individual run has a
  one-retry validator. Output shape is identical to v1 — storage,
  WS events, and UI all stay put. (`task_planning` runs stay
  single-shot; the lens metaphor doesn't apply there.)

### Phase 9.5 — Lifecycle hardening (arch gate, chat-flow edges, code onboarding) ✅ shipped
A polish pass after Phase 9 that closed three usability holes the user
hit while playing with the system live. Scope-wise this lands across
phases 3 (Flow), 7 (Code), and 8 (Architecture); we group it here so
the contract reads in shipping order.

**Chat-driven flows now ship as graphs, not as orphan nodes.**
- `add_flow_edge` and `add_arch_edge` accept `*_node_label` /
  `*_service_name` as alternatives to ids. Server-side
  `resolveNodeRef` / `resolveServiceRef` resolves label→id under the
  project lock, with most-recently-created match winning. This is the
  escape hatch agents need: when a chat reply emits
  `add_flow_node` then `add_flow_edge` in the same turn, the edge can
  reference the just-created node by label even though the id wasn't
  echoed back yet. Existing id-form callers (the click-ops UI) keep
  working — id is preferred when both are present.
- Chat system prompt (`commandVocabulary` in
  `server/src/commands/system_prompt.ts`) now states explicitly that
  flows are graphs (a node-only flow is broken), shows two worked
  examples — drafting a flow over two turns and sketching an
  architecture in one turn using `*_name` references — and reminds the
  agent the council is there to help the agent decide, not to
  decide *for* the user.
- Project context preamble surfaces the architecture state every turn
  so the agent knows when the planning gate is closed and proposes
  `approve_architecture` conversationally rather than guessing.

**Architecture is a hard gate before tasks are made.**
- `Architecture` gains an optional `approved_at: number` field
  (mirrored on the client `Architecture` type). New verbs
  `approve_architecture` and `unapprove_architecture` (project-scoped)
  set / clear it. `approve_architecture` rejects empty architectures.
- `applyRequestTaskPlanning` now checks both:
  1. `architecture.services.length > 0`
  2. `architecture.approved_at` is set
  …and rejects with a self-pointing error
  ("Open the Architecture tab and click Approve") otherwise. The
  pre-existing `flow_approved` gate is preserved.
- Any semantic edit on services or edges (add, remove, name change,
  kind change, description change) auto-clears `approved_at` via
  `invalidateArchitectureApproval`. **Position-only edits** (x/y from
  drag-rearranges on the canvas) explicitly preserve `approved_at` —
  moving boxes around isn't a re-architecture.
- `ArchitectureCanvas` gets an approval banner with three states —
  `EMPTY`, `AWAITING APPROVAL` (with a green APPROVE button), and
  `APPROVED at <date>` (with the "edits will require re-approval"
  caveat and a discreet UNAPPROVE escape hatch).
- `CouncilPanel` accepts `architectureState`. When a feature is
  `flow_approved` but the architecture gate is closed, the "PLAN
  TASKS" button is replaced by a disabled `PLAN TASKS · ARCH NOT
  APPROVED` (or `· ARCH EMPTY`) chip with an italic hint pointing at
  the Architecture tab. `FlowCanvas` derives the state from the
  `architecture` prop and threads it down.

**Code tab works on planning-only projects.**
- New `update_project` verb. Accepts partial patches —
  `{ slug, name?, description?, workspace_path? }`. The
  `workspace_path` field accepts a string (use as-is), `"auto"` (server
  creates `$WORKSPACE_DIR/<slug>` and git-inits, mirroring
  `create_project`'s `"auto"` mode), `null` (revert to planning-only),
  or omit (untouched). Mirrored to both `fleet.json` and
  `<slug>/project.json`.
- `CodeBrowser` empty-state replaced with an inline two-option setup
  card: a one-click "CREATE $WORKSPACE_DIR/&lt;slug&gt;" button (auto
  mode) and a path-typed input for an existing folder. Submits via
  `applyMutation`; on success the component re-renders into the real
  file tree on the next state push.

### Phase 10 — Tools (reusable agent skills) ✅ shipped
The OpenHands "skills" / OpenClaw concept, called **tools** here. A tool
is a named, parametrized prompt template that runs against a project
workspace via `cursor-agent`.

Examples a user can build:
- `run_tests` — "in the project's repo, run the test suite, report
  failures, and emit a `complete_task` only if all green"
- `bump_dep` — "upgrade the named package, run install, ensure the build
  still passes"
- `add_migration` — "scaffold a new DB migration file matching this repo's
  conventions, with the user-supplied description"

Implementation:
- `tools.json` at the store root holds the registry: `[{ id, name,
  description, category?, prompt_template, params: [{ name, type, label?,
  description?, required?, default?, options? }], status, created_at,
  updated_at }]`. Param types: `string`, `text`, `number`, `boolean`,
  `enum`. The registry is global; tools are reused across projects.
- Tiny **Mustache-lite renderer** (`server/src/tools/render.ts`):
  - `{{var}}` substitutes the named arg
  - `{{var | "fallback"}}` falls back to a literal when arg is empty
  - `{{#var}}…{{/var}}` conditional block, included only when arg is
    truthy/non-empty
  - No nesting, no helpers, no filters — auditable templates only.
  - `coerceArgs(params, args)` validates required-ness, coerces numbers
    and booleans, and rejects out-of-`options` enum values up front.
- New verbs: `create_tool`, `update_tool`, `archive_tool`, `run_tool`.
  - `run_tool { tool_id, project_slug, args, title?, priority?,
    auto_start? }` creates a Task carrying `tool_id` + coerced
    `tool_args`. With `auto_start: true` it dispatches the run on the
    queue worker immediately; otherwise the task waits for the user to
    click Run on the queue.
- `Task` gained `tool_id?` and `tool_args?` fields. When the queue
  worker picks up a task with `tool_id`, it builds the prompt via
  `buildToolTaskPrompt(tool, args, …)` (rendered template wrapped in
  the standard task-runner scaffolding) instead of the generic task
  executor. Falls through to the standard prompt if the tool was
  archived/deleted while the task was queued.
- New endpoints: `GET /tools` (filter `?include_archived=1`) and
  `GET /tools/:ref` (where `ref` is the slug or id — see Phase 10.1).
- **Tools tab on the global cockpit** (alongside Chat and Cron). List
  view, create/edit modal with per-row param editor, and a Run modal
  that picks a project + collects args + toggles auto-start.

### Phase 10.1 — Tools-as-API ✅ shipped
Tools also need to be **callable** without going through the chat
agent — both for ad-hoc invocation (curl, scripts) and for future
composition (cron, agents, other tools wrapping each other). We bolt a
thin API surface on top of the existing tool/queue plumbing rather
than inventing a parallel runtime.

Stable addressing — tools gain a **slug** field:
- Auto-derived from `name` on `create_tool` ("Run Tests" → `run-tests`),
  no random suffix.
- Unique among active tools. Auto-derived collisions get `-2`, `-3`, …;
  explicit `slug` collisions return `409`.
- Editable on `update_tool` (also collision-checked).
- Backfilled at read-time for any pre-10.1 records — readers see
  consistent slugs even before the next write.

Three new endpoints under `/v1/tools/...` — `:ref` accepts slug or id:

| verb / route | semantics |
|---|---|
| `POST /v1/tools/:ref/run` | Invoke. Body: `{ project_slug, args?, title?, priority?, wait?, timeout_ms? }`. Default async — returns `202 { ok, run: { run_id, task_id, status, … } }` with `run_id == task_id`. With `wait=true` blocks on the in-process event bus until the task finishes; on success returns `200 { ok, run }` carrying `result.summary`, `result.artifacts`, and a 16 KiB tail of `raw_output_excerpt`. On timeout returns `202 { ok, run, note }`. Internally calls `applyMutation({ kind: "run_tool", … auto_start: true })` so coercion, validation, project assertion, and queue dispatch all share one code path. |
| `GET /v1/tool_runs/:run_id` | Polling. `run_id` is the task id. Walks the fleet to find the task, derives `status` from the latest `TaskRunRecord` (or task status if no record yet), pulls `summary`/`artifacts` from the `complete_task` pill. |
| `GET /v1/tools/:ref/runs` | List historical runs of a given tool. Filter with `?project_slug=…` or `?limit=N` (default 20, max 100). Sorted newest-first. |

Subtle correctness fixes that came along:
- `events.broadcast(task_finished)` now fires **after** the run record
  is persisted — listeners (the sync API) can read the record without
  racing the writer.
- `events.subscribe(listener)` is a new in-process API on the event
  bus. Used by `awaitTaskFinish(taskId, timeoutMs)` for the sync path.
- Always cleans up the listener (incl. the timeout-cancel path) so we
  don't leak callbacks.

Internal-only — no auth (decision: tools are an abstraction layer for
agents/cron/scripts on the same host, not a public API). Lift to
external when there's a real second caller.

### Phase 11 — Cron / scheduled jobs ✅ shipped
Once tools exist, scheduling is a small step.

Implementation:
- `cron.json` at the store root: `{ jobs: [{ id, name, description?,
  schedule, target, enabled, last_run_at?, last_status?, last_error?,
  created_at, updated_at }] }`.
- `target` is a discriminated union:
  - `{ kind: "tool", tool_id, project_slug, args?, priority? }` — fire
    a tool-backed `run_tool` against a project on schedule.
  - `{ kind: "queue", project_slug? }` — kick the queue worker on a
    schedule, scoped to one project or fleet-wide.
  - `{ kind: "task", project_slug, title, description?, priority?,
    feature_id?, auto_start? }` — Phase 11.1: recurring raw task
    creation. Each tick fires `add_task`. With `auto_start: true` the
    scheduler also fires `start_task` so the queue worker dispatches
    immediately; otherwise the task lands in the backlog as `todo`.
    Fills the gap between "make a Tool just to schedule one
    plain-language reminder" and "manually drop a card into the
    backlog every Monday".
- **Tiny crontab matcher** (`server/src/cron/expr.ts`): standard 5-field
  syntax (`min hour dom month dow`), supports `*`, single ints, comma
  lists, ranges (`1-5`), strides (`*/5`, `9-17/2`). Day-of-week 0–6
  (Sun–Sat); `7` aliases to `0`. No name aliases (`MON`, `JAN`) — keeps
  the parser tiny.
- **Scheduler loop** (`server/src/cron/scheduler.ts`): aligns to the
  next minute boundary, then polls every 60s. On each tick it reads the
  registry, evaluates enabled jobs against the tick's clock, and
  dispatches matches via the same `applyMutation` plumbing the chat /
  UI use. Idempotency: each job's `last_run_at` is stamped to the tick
  start; if the loop revisits the same minute (paused/resumed server),
  it skips. Single-process; an invalid schedule on one job logs a
  warning and doesn't crash the loop.
- New verbs: `create_cron`, `update_cron`, `archive_cron`,
  `set_cron_enabled`, `run_cron_now`.
- Same id-or-name escape hatch as `add_arch_edge`: `target.tool_name`
  fallback for `target.tool_id`, so an agent can `create_tool +
  create_cron` in one chat turn (most-recently-created active tool with
  that name wins).
- New endpoint: `GET /cron`.
- **Cron tab on the global cockpit**. List view with state/last-run
  metadata, per-row Run-Now / Disable / Edit / Archive buttons, and a
  create modal with schedule presets (`every minute`, `every 5 min`,
  `hourly`, `every 4 h`, `daily 09:00`, `weekly Mon 09:00`) plus a free-
  form expression field for anything more specific.
- This is the only place icarus runs anything *without* an explicit
  user trigger — and even then, only what the user explicitly
  scheduled.

### Phase 12 — Rules ✅ shipped
Free-form "AGENTS.md-style" guidance prepended to every cursor-agent
prompt across the fleet.

Why: Cursor users already think in terms of `.cursorrules` / `AGENTS.md`.
Mirror that pattern so persistent guidance — house style, "always run
the typecheck before claiming done", "use kebab-case for slugs" — lives
in one obvious place and applies everywhere.

Two scopes:
- **Global** (`store/rules.json`) — applied to every cursor-agent run
  across every project: chat, queue/task worker, council lenses + chair,
  tool runs.
- **Project** (`store/<slug>/rules.json`) — applied only when the
  current scope is that project. Stacks on top of the globals.

Implementation:
- Domain (`Rule`): `{ id, scope: "global"|"project", project_slug?,
  title, body, category?, enabled, status, created_at, updated_at }`.
  `enabled: false` is a fast mute; `status: "archived"` is soft delete.
  Bodies are markdown, capped at 8 KB by Zod and at 1.5 KB *per rule*
  by the injection helper (defensive against pathological growth).
- Storage: same `{ rules: [...] }` envelope as tools/cron. Reads always
  pass a *fresh* fallback to `readJsonOr` — a shared `EMPTY` constant
  bit me during smoke testing because applicators mutate the returned
  array in place.
- Mutations (4 verbs): `create_rule { scope, title, body, category?,
  enabled? }`, `update_rule { rule_id, scope?, title?, body?,
  category?, enabled? }`, `archive_rule { rule_id, scope? }`,
  `set_rule_enabled { rule_id, enabled, scope? }`. The `scope?` on the
  non-create verbs is a fast-path; when absent the applicator scans
  global + every project for the id.
- Locks: globals serialize on `globalLocks.run("rules", …)`; per-
  project rules serialize on the existing per-project lock.
- **Injection helper** (`server/src/rules/inject.ts`):
  `formatRulesBlock(scope) -> Promise<string>` reads the active rules
  for the scope and returns a markdown-ish block prefixed with
  `[icarus rules — apply throughout this run]`. Returns `""` when
  nothing is enabled, so callsites concatenate without extra logic.
  Global rules render first, project rules second.
- Wired into every `cursor-agent` invocation:
  - `chats.ts buildPrompt` — prepended before `commandVocabulary`.
  - `queue/worker.ts buildPrompt` — prepended to both
    `buildTaskExecutionPrompt` and `buildToolTaskPrompt` outputs.
  - `council/runner.ts` — prepended to each of the 5 lens prompts +
    the chair prompt, and to the task-planning prompt.
- New read endpoints: `GET /rules` (global), `GET /projects/:slug/rules`
  (project). Both default to `status: "active"`; pass
  `?include_archived=1` for the full set.
- **Rules tab** on both the global cockpit and per-project view (shared
  `RulesPanel`). Inline ON/OFF toggle for fast experiments, edit and
  archive on every row, modal editor with title + body + category +
  enabled toggle.
- Agent vocabulary (`commandVocabulary`) includes the four rule verbs
  so the user can ask the agent to author/edit rules from chat ("add a
  global rule that says always run the typecheck before claiming
  done").

### Phase 13 — Tool auto-suggestion ✅ shipped
"Just like OpenClaw skills" — when the agent notices it just did
something with a clear repeatable shape, it emits a `propose_tool`
pill mid-stream. The user reviews, tweaks if needed, and accepts to
turn it into a real reusable Tool.

Why agent-emits (vs server-side detection or post-turn analysis):
- The agent already has the full context of what it just did, why,
  and which knobs are interesting params. Detection from outside
  would be guessing.
- Reusing the same icarus-fence command protocol means no new client
  plumbing — the proposal flows through the existing pill stream and
  mutation envelope.
- Conservative-by-default lives in the system prompt, where we can
  iterate on what counts as "worth proposing" without touching code.

Domain (`ToolProposal`): `{ id, status: "pending"|"accepted"|"rejected",
name, description?, category?, prompt_template, params?, rationale?,
source: { kind: "chat"|"task"|"tool_run", project_slug?, chat_id?,
message_id?, task_id? }, tool_id?, created_at, updated_at }`. Same
field shape as `create_tool` minus the slug — slug is decided at
accept time so the user can pick a clean URL.

Storage: `store/tool_proposals.json`. Global file (since the resulting
tools are global) with a per-record `source.project_slug` for
provenance. Same fresh-fallback pattern as Phase 12 storage.

Mutations (3 verbs, all global lock `tool_proposals`):
- `propose_tool { name, prompt_template, params?, rationale?, source,
  … }` — agent emits this; persists `pending`. Re-validates `params`
  with the same `validateToolParams` used by `create_tool` so the
  user can't accept a malformed proposal.
- `accept_tool_proposal { proposal_id, overrides? }` — reads under
  the proposals lock, builds a `CreateToolPayload` from
  `proposal + overrides`, hands off to `applyCreateTool` (which takes
  the `tools` lock), then re-takes `tool_proposals` to flip status
  to `accepted` and stamp `tool_id`. Two-phase to keep lock order
  consistent.
- `reject_tool_proposal { proposal_id }` — soft-delete; idempotent
  for already-rejected; 409 for accepted.

System prompt: a new `propose_tool` block in `commandVocabulary` lists
the payload fields *and* explicit emit-when guidance. Two examples of
"good to propose" (parametrized refactor, multi-step recipe) and
three examples of "do NOT propose" (one-off explorations, single-line
shell commands, work the user framed as one-time). Crucially: the
verb is **non-terminal**, so the agent emits it alongside its normal
`complete_task` / equivalent, never instead.

Read endpoint: `GET /tool_proposals?include_all=1`. Default returns
only `pending` proposals — that's the working set. `include_all=1`
returns the full audit trail so a user can review past decisions.

UI:
- A **Suggestions banner** at the top of the global Tools tab when
  `pending.length > 0`. Each row shows name, rationale, source
  (`from chat · slug-of-project`), param count, and two actions:
  ACCEPT (opens the existing `ToolEditorModal` pre-filled via a
  `seedDraft` prop, save dispatches `accept_tool_proposal`) and
  REJECT (dispatches `reject_tool_proposal` directly).
- A **count badge** on the global Tools tab pill so the user spots
  pending suggestions even from a different tab. Hidden when zero.
- WS event handler refreshes both `toolProposals` and (on accept)
  `tools` whenever any proposal mutation lands — so two clients
  watching the same workspace stay in sync without polling.

Smoke results (verified 2026-05-05):
- propose → lands as `pending`, default GET returns it, file persists.
- accept with overrides (rename + custom slug + edited description) →
  proposal flips to `accepted` with `tool_id` set; new tool appears
  in `/tools` with the overridden fields, params and prompt template
  preserved from the proposal.
- reject → status flips to `rejected`, default GET hides it,
  `?include_all=1` shows it.
- accept on rejected → 409. reject on accepted → 409. accept on
  unknown id → 404. reject on already-rejected → idempotent 200.
- Schema validation: missing `source` rejected with 400, invalid
  param identifier rejected with 400.

### Phase 14 — Custom Council Personas ✅ shipped

Until now, the council ran a fixed 5-lens panel — `product`, `ux`,
`architecture`, `security`, `operability` — baked into the runner.
Phase 14 makes that panel data-driven so users can replace any
default lens with their own charter or add new lenses entirely
(e.g. `marketing`, `legal`, `devrel`).

Design picks (from the same conversation that opened Phase 13):
- **Scopes**: `global_and_project`. Globals apply to every project.
  Project personas override globals on the same key, or add new
  keys for that project only.
- **Mode**: `replace_lenses`. A persona's `key` is the lens slot id.
  Match a default key (`product` / `ux` / `architecture` / `security`
  / `operability`) to *replace* that slot; use any other key (e.g.
  `marketing`) to *add* a new lens to the panel.
- **Charter is prose, not Mustache.** `prompt_template` is the
  lens-specific brief; the runner wraps it with the standard council
  framing so authors only write the unique part.

Domain (`server/src/domain.ts`, mirrored in `app/src/types.ts`):
```
Persona { id, scope, project_slug?, key, name, description?,
          prompt_template, accent?, status, created_at, updated_at }
```

Storage:
- `store/personas.json` — global registry.
- `store/<slug>/personas.json` — per-project registry.

Resolution (`server/src/personas/registry.ts::resolveCouncilPersonas`):
1. Walk default order. For each default key, project beats global
   beats default — pick the most-recent active persona for that key.
2. Append global personas with non-default keys (sorted by
   created_at). Project still wins on duplicate non-default keys.
3. Append project-only additions (sorted by created_at).

Result is a deterministic, ordered `ResolvedPersona[]` annotated
with provenance per slot. The Personas panel renders this directly
so users can see at a glance where each lens came from.

Mutations (Zod-validated, scope-locked):
- `create_persona` — adds a persona at the requested scope.
- `update_persona` — patches name / description / prompt_template /
  accent / key (so users can re-aim a custom persona at a default
  slot). Scope is optional; falls back to id-scan via `findPersonaById`.
- `archive_persona` — soft-delete; archived personas are dropped
  from the resolved panel but stay on disk for audit.

Council runner refactor (`server/src/council/runner.ts`):
- `runFlowReviewParallel` resolves the persona list once at the top
  of the run, then fans out one cursor-agent call per resolved
  persona. The chair prompt is parameterized on lens count
  (previously hard-coded to "5-lens panel").
- `parseSingleLensEnvelope` now takes the expected ResolvedPersona
  and validates the model's `lens` field against `persona.key`
  rather than a hardcoded enum.
- `LENS_IDS` and the `z.enum([...])` constraint on `lens` are gone;
  the schema accepts any non-empty string and the runtime checks
  enforce membership in the resolved set.

Agent vocabulary (`commands/system_prompt.ts`):
- `create_persona`, `update_persona`, `archive_persona` are now
  available verbs. The vocabulary block explicitly lists default
  keys so the agent knows when it's replacing vs. adding.

API:
- `GET /personas` / `GET /projects/:slug/personas` — registry views,
  default filter to active; pass `?include_archived=1` for the full
  list.
- `GET /personas/resolved` / `GET /projects/:slug/personas/resolved`
  — what the council will actually run, with provenance per slot.

UI:
- New global tab `PERSONAS` and a per-project `Personas` tab.
- Single shared `PersonasPanel` component:
  - **Resolved lens panel** at the top — the panel that the council
    will actually execute, with a "DEFAULT" / "GLOBAL" / "PROJECT"
    pill per slot.
  - **Owned at this scope** below — only the personas the user has
    authored at the current scope (so the global tab doesn't show
    project entries and vice versa). Each row labels itself
    "REPLACES DEFAULT" or "NEW LENS" so users know what their key
    will do.
  - Editor modal handles key normalization (lowercases + slugifies
    on the fly) and shows a contextual hint that flips between
    "this will REPLACE the default" and "this will ADD a new lens"
    based on the live key value.

Smoke results (verified 2026-05-05):
- 5 default lenses resolve to `source=default` when no personas exist.
- Global persona overriding `ux` flips that slot to `source=global`,
  with `persona_id` set; the four other defaults stay put.
- Project persona on a *new* key (`marketing`) appends as a 6th lens
  with `source=project`.
- Project persona on an *existing* key beats both global and default
  for that slot (`source=project` win confirmed).
- Archive cascade: archive project ux → falls back to global ux;
  archive global ux → falls back to default ux. Both done in one
  session.
- Validation: invalid keys (uppercase, leading hyphen) rejected with
  400; unknown project_slug → 404; unknown persona_id on archive →
  404; invalid accent enum → 400.
- Compiled runner uses `resolveCouncilPersonas` (verified by
  inspecting `dist/council/runner.js`); `LENS_IDS` is gone.

---

### Phase 15 — Voice commands & navigation ✅ shipped

The whole point of Phase 15: turn icarus into a hands-free agent.
Talk to it, hear it back, and let voice route you across the UI.
Backed by self-hosted Whisper (STT) and XTTS-v2 (TTS) — typically
running on a Jetson AGX Orin (`tools/{stt,tts}-service` in this
repo's sister repo, or any HTTP-compatible service) — both wrapped
behind icarus-server so the client never sees the upstream URL.

**Decisions** (locked at the top of the phase, see the design
question set in the chat transcript):

- **Server proxies the Orin.** No direct browser-to-Orin calls.
  All voice traffic flows through `/v1/voice/*` on icarus-server,
  configured by env (`VOICE_STT_URL`, `VOICE_TTS_URL`,
  `VOICE_TTS_VOICE`, `VOICE_TTS_LANGUAGE`). Single seam to swap
  upstreams or add auth later. Means we don't need CORS on the
  Orin side either.
- **TTS only when the user spoke.** The store tracks
  `voice.lastInputWasVoice` — flipped on by `voiceStopAndSend`,
  flipped off after the assistant turn finishes. Typed
  conversations stay silent.
- **Phase 15.1: speak a paragraph, not the whole reply.** Long
  assistant replies used to read aloud in full — fine in chat,
  miserable as audio. Now: when a voice-triggered turn completes,
  the client posts the full reply to
  `POST /v1/voice/spoken_for_text` and feeds the returned
  `spoken_text` to the speaker. The server picks one of three
  paths: replies under ~600 chars (after markdown stripping)
  pass through unchanged (`source: "passthrough"`); longer
  replies trigger a one-shot `cursor-agent` summary call that
  returns ≤3 sentences of plain prose (`source: "summary"`); on
  summary failure or out-of-bounds output we degrade to a
  deterministic truncate (first three sentences + *"Full reply
  is in chat."* outro, `source: "truncate"`). Mid-stream sentence
  playback is dropped for voice replies — we wait for the full
  text + spoken-fetch round-trip before starting audio. The
  trade is intentional: a few seconds of silence beats minutes
  of essay. Chat display is untouched — the persisted assistant
  message is still the full reply. Cancellation-safe: the
  speaker's `getGeneration()` is captured at turn-start and
  re-checked after the spoken fetch, so re-arming the mic
  mid-fetch drops the stale audio instead of talking over the
  new recording session.
- **Voice = `default` clip.** That's the only voice the Orin's
  catalog ships with right now. Configurable by env if/when we
  drop more samples in `tools/tts-service/voices/`.
- **Navigation is agent-mediated.** No client-side regex parser.
  The agent emits a `navigate` mutation; the server validates
  the target id and broadcasts a WS `nav_request` event with the
  originating client's id. Ambiguity ("two projects match") falls
  through to `add_question` like any other underspecified ask.
- **Floating mic button.** Bottom-right, click-to-arm /
  click-again-to-stop, works on every tab (so "go to features"
  is reachable from Tasks). Hidden when `/v1/voice/health`
  reports unhealthy.
- **Confirm-first flow.** Stop doesn't auto-send — STT lands in
  a `pending` state and a preview bubble surfaces the transcript
  for the user to review. From there: hit Send (or Enter) to
  fire the chat, click the mic again to re-record (replaces
  the held transcript with the new utterance — the "talk to
  change it" path), edit the text inline if STT mishears one
  word, or hit Discard to bail. This avoids the "I said the
  wrong thing and it sent immediately" failure mode.
- **Transcripts land in the active scope's chat.** Project chat
  if you're inside a project, global chat otherwise.
- **Task nav lands as a "ping", not a selection.** When the agent
  emits `navigate { kind: "task", task_id: ... }` the Tasks tab
  isn't a single-select surface (it's a Kanban), so we paint a
  transient cyan glow on the matching card via
  `highlightedTaskBySlug` in the store. Auto-clears after 5s so
  the highlight reads as a one-shot signal rather than sticky
  state. Project + feature nav already have stable selection
  state to lean on (`view.kind: "project"`, `selectedFeatureBySlug`)
  so they don't need this trick.
- **Each lens carries its persona's accent.** The
  `Persona.accent` enum (`cyan | violet | amber | green | rose`)
  paints a thin 3px left edge on each council verdict card and
  tints the lens name. The verdict tone keeps the full card
  border (so approve / changes / approve-with-notes still reads
  unambiguously). Net effect: a custom "marketing" lens with
  `accent: "rose"` is instantly distinguishable from the default
  UX lens, even when both verdicts are green. Lost in the
  Phase 14 refactor; piped back through `FlowCanvas` →
  `CouncilPanel` → `LensCard`.
- **Phase 15.2: voice-answered questions.** The Questions tab is
  the second voice surface (after the global mic). Each open
  question card shows a "🔊 SPEAK & ANSWER" pill: clicking it
  cancels any in-flight playback, reads the question body aloud
  via the same TTS path as chat replies, and *locks the global
  voice target* to that question (`voice.target = { kind:
  "question", question_id, project_slug, preview }`). The next
  time the user clicks the floating mic and confirms a
  transcript, the store's `voiceConfirmAndSend` notices the
  locked target and fires `answer_question` instead of routing
  to chat. The card itself glows cyan + reads "● VOICE READY"
  while it's the active target so the user can see at a glance
  where their next utterance is going. The preview bubble
  carries the same "→ ANSWERING: <q>" inset, and the SEND
  button retitles to "SEND ANSWER" — three independent
  affordances (card glow, floating banner, bubble inset) all
  point at the same fact. Target *only* affects the voice
  confirm path: typing a chat message ignores it. Auto-resets
  to `chat` on confirm / discard / cancel, plus a ✕ on the
  floating banner for manual reset. Skipped auto-arming the
  mic after audio finishes because web's `getUserMedia` loses
  its user-gesture context across the async audio playback —
  reliable two-click flow (SPEAK → MIC) beats a flaky
  one-click attempt. Typed answers via the inline reply box
  are unchanged; voice is purely additive.

**Server side**

- `server/src/voice/config.ts` — reads `VOICE_*` env, exposes
  `isVoiceEnabled(cfg)`. Voice is feature-flagged off when either
  URL is unset (no behavior change to existing deployments).
- `server/src/voice/stt.ts` — `transcribe(cfg, audioBytes, opts)`.
  Wraps the Orin's `POST /transcribe` (multipart). Accepts raw
  bytes + content type so the icarus client can upload as
  `application/octet-stream` instead of multipart (saves us
  pulling in `multer`). Threading: native `fetch` + `FormData`,
  Node 20+. `VoiceProxyError` carries `httpStatus` + upstream
  body for clean route-layer error mapping.
- `server/src/voice/tts.ts` — `synthesize(cfg, opts)` wraps
  `POST /synthesize` (XTTS-v2). Returns `{ audio, contentType,
  voice, language }`. Also exports `splitSentencesForTTS(text)` —
  a sentence splitter that strips markdown / code fences / bare
  URLs so the speaker doesn't read "asterisk asterisk" out loud.
  Used by the streamed-playback path on the client.
- `server/src/voice/health.ts` — `readVoiceHealth(cfg)` probes
  both upstreams in parallel with a 4s timeout. Returns the
  combined `{ available, stt, tts }`. Also surfaces the common
  foot-gun "configured voice doesn't exist in the upstream
  catalog" as `tts.ok = false` with a precise reason.
- `server/src/voice/spoken.ts` (Phase 15.1) —
  `computeSpokenForText(text, cursorOpts)` returns the
  TTS-friendly version of an assistant reply. Branches on
  cleaned length: ≤ `SPOKEN_PASSTHROUGH_CHARS` (600) →
  passthrough; otherwise calls a tight one-shot summary prompt
  via `runOneShot`. Caps the summary at
  `SPOKEN_SUMMARY_CHAR_CAP` (700) and degrades to
  `truncateForSpeech` (3-sentence prefix + outro) on either
  failure or out-of-bounds output. Never throws — the worst
  case is `source: "empty"` for stripped-empty inputs.

**HTTP routes** (mounted in `server/src/index.ts`):

| Route | Body | Returns | Notes |
|---|---|---|---|
| `GET /v1/voice/health` | — | `{ available, stt, tts }` | Cheap probe; client polls once at startup. |
| `POST /v1/voice/transcribe` | raw audio bytes | `{ text, language, duration }` | `Content-Type: application/octet-stream`; client passes original audio mime via `X-Audio-Content-Type`. 25 MB cap. `?language=en` and `?task=transcribe\|translate` optional. |
| `POST /v1/voice/synthesize` | `{ text, voice?, language?, speed? }` | `audio/wav` (24kHz PCM16) | Voice/language fall back to env defaults. |
| `POST /v1/voice/split_sentences` | `{ text, max_chars? }` | `{ chunks: string[] }` | Pure helper, no upstream call. Used by client-side incremental playback. |
| `POST /v1/voice/spoken_for_text` | `{ text }` | `{ spoken_text, source, original_chars }` | Phase 15.1. Returns the TTS-friendly version of an assistant reply. `source` is `passthrough` (short) / `summary` (cursor-agent) / `truncate` (fallback) / `empty`. Never throws — always returns playable text. |

**Navigate verb**

- `server/src/mutations/schema.ts` — `NavigatePayload` is a
  discriminated union over `target.kind` (`global` | `project` |
  `feature` | `task`). Tabs are explicit enums (project: chat /
  tasks / features / flows / architecture / code / questions /
  rules / personas / activity; global: chat / tools / cron /
  rules / personas).
- `server/src/mutations/applicators.ts` — `applyNavigate`
  validates project_slug / feature_id / task_id against the live
  fleet. Unknown id → `ApplicatorError(404)` so the agent's
  schema-retry loop picks it up and either corrects or asks via
  `add_question`. No disk writes — just a `nav_request` WS
  broadcast carrying `{ client_id, target, reason, ts }`.
- `server/src/events.ts` — adds the `nav_request` event variant.
- `server/src/commands/system_prompt.ts` — adds `navigate` to the
  agent's command vocabulary with explicit examples and the
  "if ambiguous, raise an `add_question`" guidance.
- `server/src/chats.ts` + `server/src/index.ts` — plumb an
  optional `client_id` from the chat send through to every
  mutation envelope produced by the turn (injected by `closePill`
  alongside the existing `project_slug` injection). The agent is
  never told the client_id; it's stamped server-side.

**Client side**

- `app/src/voice/client_id.ts` — opaque per-tab id, generated
  once on first access via `crypto.randomUUID()`. Sent on every
  `sendMessage` so the WS `nav_request` listener can scope to
  the originating tab.
- `app/src/voice/recorder.ts` — `WebRecorder` thin wrapper around
  `MediaRecorder`. Picks the best supported mime (webm/opus →
  webm → ogg/opus → ogg → mp4), reuses the cached `MediaStream`
  across recordings (saves the permission round-trip), and
  surfaces `start` / `stop` / `cancel` / `release`. Native
  (Expo) currently unsupported — `recorderSupported()` returns
  false on `Platform.OS !== "web"` and the floating button hides.
- `app/src/voice/speaker.ts` — `TTSPlayer` queue-based playback.
  Re-fed the cumulative assistant text on every chunk; uses
  `/v1/voice/split_sentences` to break into utterance-sized
  pieces, dedupes already-spoken chunks, fetches each as a
  blob URL, plays them sequentially via `HTMLAudioElement`.
  `cancel()` bumps a generation counter so in-flight fetches
  detect they're stale; `onIdle(cb)` fires when the queue
  drains so the store can flip `voice.state` back to `idle`.
- `app/src/voice/controller.ts` — module-level singletons for
  the recorder + speaker so the store can grab them lazily
  without knowing about lifecycle.
- `app/src/api.ts` — adds `getVoiceHealth`, `transcribeAudio`.
- `app/src/store.ts`:
  - New `voice: { available, healthReason?, state,
    pendingTranscript, error, lastInputWasVoice }` slice.
    `state` is a 5-state machine: `idle | recording |
    transcribing | pending | speaking`.
  - Actions: `refreshVoiceHealth`, `voiceArm`,
    `voiceStopAndPreview` (was `voiceStopAndSend` — now lands
    in `pending` instead of firing the send),
    `voiceEditPending`, `voiceConfirmAndSend`,
    `voiceDiscardPending`, `voiceCancel`, `setVoiceState`.
  - `voiceArm` clears `pendingTranscript` on entry — re-arming
    while pending is the "talk to change it" path; the new
    utterance fully replaces.
  - Empty STT result (silence / mishap) drops back to `idle`
    with a friendly error rather than landing in a `pending`
    state with no content.
  - `send` action threads `getClientId()` into the chat send
    body; when `voice.lastInputWasVoice` is true the streaming
    chat output is also fed into the singleton speaker.
  - WS subscription handles `nav_request`: filters by
    `client_id` (only the originating tab navigates), then
    dispatches to `selectGlobal` / `selectProject` /
    `selectFeature`.
- `app/src/components/VoiceButton.tsx` — fixed-position
  bottom-right of the viewport (web-only via `position: "fixed"`
  cast, returns `null` on native). Two stacked surfaces:
  - **Mic button**, color/label by state: cyan/TALK (idle),
    red/STOP + pulse (recording), amber/TRANSCRIBING…
    (disabled during STT), cyan/RE-RECORD (while pending —
    clicking it replaces the held transcript), violet/SPEAKING…
    (click cancels playback).
  - **Preview bubble**, only when `state: "pending"`. Holds an
    editable `<TextInput>` seeded with the transcript plus a
    three-button row: DISCARD (text-secondary, no-op exit),
    RE-RECORD (cyan, fires `voiceArm`), SEND (green, fires
    `voiceConfirmAndSend`; emphasized fill so it reads as the
    primary action). Pressing Enter inside the field also
    fires send. A one-line hint at the bottom spells out the
    keyboard shortcuts.
- `app/App.tsx` — mounts `<VoiceButton />` at the root.

**Smoke tests** (Phase 15)

- `GET /v1/voice/health` with no upstream → `{ available: false,
  stt: { ok: false, reason: "..." }, tts: { ok: false, reason:
  "..." } }`. ✅
- `POST /v1/voice/synthesize` no upstream → `502 { error: "tts
  upstream unreachable: fetch failed" }`. ✅
- `POST /v1/voice/synthesize` with empty text → `400 { error:
  "text is required" }`. ✅
- `POST /v1/voice/transcribe` with empty body → `400 { error:
  "empty body" }`. ✅
- `POST /v1/voice/split_sentences` with markdown-heavy input
  ("# Hello.\\nThis is a test! And this is **bold**. See
  https://example.com for more.") → strips fences, bullets, URLs,
  yields `["Hello.", "This is a test!", "And this is bold.",
  "See for more."]`. ✅
- `applyMutation { kind: "navigate", payload: { target: { kind:
  "global", tab: "tools" }, reason: "go tools" }, client_id:
  "c-1" }` → 200, WS broadcasts `{ type: "nav_request",
  client_id: "c-1", target: { ... } }`. ✅
- Same with `kind: "project"` + valid slug → 200, WS event with
  `tab: "tasks"` and originating `client_id`. ✅
- Same with unknown project slug → `404 { error: "unknown
  project slug: ..." }`, no WS broadcast. ✅ (The agent's
  retry loop sees the rejection and either fixes the slug or
  raises an `add_question`.)
- **Round-trip live against the Orin** (server run natively,
  Docker bypassed): synthesized "Welcome to Icarus. All systems
  are nominal." through `/v1/voice/synthesize` → 178 KB
  RIFF/WAVE/PCM16/24 kHz mono → re-uploaded raw bytes to
  `/v1/voice/transcribe` → got back exact same string + `language:
  "en"`, `duration: 3.788s`. ✅
- **Full agent-mediated nav** end-to-end: posted "Open the tools
  tab on the global cockpit." to a global chat with
  `client_id: "voice-smoke-1"`. Agent emitted `navigate { target:
  { kind: "global", tab: "tools" }, reason: "open tools tab on
  global cockpit" }`; WS broadcast a `nav_request` with the
  originating `client_id` and that exact target. ✅

**Operational note: Docker Desktop on macOS LAN access.** The
icarus-server container needs to reach the voice STT/TTS hosts
on your LAN (e.g. a Jetson at `<your-jetson>:8001/8002`). Docker
Desktop's bridge networking on macOS NATs container outbound
traffic in a way that breaks LAN peer connections (you can reach
the public internet but not other LAN hosts). Two ways to fix:

1. **Enable host networking in Docker Desktop** (Settings →
   Resources → Network → "Enable host networking"), then add
   `network_mode: host` back to the server in
   `docker-compose.yml`. The `ports: 4000:4000` mapping becomes
   implicit (the container binds :4000 directly on the Mac).
2. **Run icarus-server natively for now** — `cd server && npm
   install && npm run dev`. App container still works as-is
   (it just talks to `localhost:4000`).

The voice routes themselves are fully wired and tested — they
fall back to clean `502` errors when the upstream is unreachable,
so the rest of the app keeps working with the mic button hidden.

### Phase 17 — Cursor usage panel ✅ shipped

> "If at all possible we want to have our current cursor usage/spend
> so we can see how many tokens we have left for the month."

Cursor doesn't expose a stable usage API to individual API keys —
`crsr_…` tokens authenticate `cursor-agent` execution but can't read
billing. The Admin API at `api.cursor.com/teams/*` is gated behind
Team/Enterprise plans + a separate admin key. The web dashboard at
`cursor.com/dashboard` and the various community usage extensions
all hit an undocumented Connect-RPC service at
`api2.cursor.sh/aiserver.v1.DashboardService/*`, authenticated with
an Auth0 JWT that the Cursor desktop app stores in
`~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`.

Phase 17 wires that path:

- New `server/src/cursor_usage/client.ts` — reads `accessToken` +
  `refreshToken` from the desktop SQLite via the `sqlite3` CLI
  (no node-native dep, keeps the runtime image lean), refreshes
  via `POST /oauth/token` when the JWT is within 60s of expiry,
  and calls `GetCurrentPeriodUsage` + `GetPlanInfo` in parallel.
- `GET /v1/cursor/usage` endpoint with a 5-minute in-memory
  cache; `?force=1` busts the cache for an explicit "refresh now"
  click. Errors return a clean `{status:"unavailable", reason}`
  envelope, never a 5xx — the UI degrades gracefully.
- Docker bind: `~/Library/Application Support/Cursor:/cursor-app:ro`
  (read-only — we never write back to the desktop's auth store
  even on token refresh, so we can't corrupt your auth state).
  Override `CURSOR_DESKTOP_HOST_DIR` on Linux/Windows where the
  desktop store lives elsewhere.
- New `<UsagePill />` slotted at the bottom of the sidebar, above
  "+ NEW PROJECT". Shows plan name + percent + a thin progress
  bar (cyan < 60%, amber 60-84%, rose ≥ 85%), included spend
  vs. limit, days remaining in the cycle, and a green "+$N
  bonus" line when free credits are still in play. Click to
  force-refresh; click in the unavailable state to open
  `cursor.com/dashboard`. Polls every 5 minutes.

**Why we don't write the refreshed JWT back to SQLite:** the
desktop app has its own refresh cycle and our writing back could
race with its updates and corrupt the auth state. The refreshed
token is held purely in memory; on server restart we re-read from
SQLite and re-refresh if needed. Tradeoff: the SQLite token will
"fall behind" the in-memory cache between desktop restarts, but
that's harmless since Auth0 accepts the refresh_token regardless.

Smoke verification (curl from inside the container, against an
Ultra plan account):

```json
{
  "status": "ok",
  "plan": { "name": "Ultra", "price": "$200/mo", "includedCents": 40000 },
  "cycle": { "startMs": 1776188537000, "endMs": 1778780537000 },
  "spend": { "totalCents": 88102, "includedCents": 40000, "bonusCents": 48102, "remainingCents": 0, "percentUsed": 73.42 },
  "displayMessage": "You've used 67% of your included usage"
}
```

### Phase 19 — Voice user toggle ✅ shipped

> "The voice API I'm not at my local network so we want a way to
> toggle that on and off."

Voice availability used to be derived purely from upstream
health: the server probed STT/TTS at the Orin's LAN IP, the
client polled `/v1/voice/health` every minute, and an unreachable
upstream meant `available:false` and a hidden mic. Functionally
correct, but every health poll burned a 4-second `AbortController`
timeout per upstream while traveling — so each refresh cycle ate
~8 seconds of wall time on totally unreachable hosts. Felt
broken; the upstream probe was working as designed.

Phase 19 adds a hard user-controlled switch. Two surfaces flip
the same boolean:

- **`<VoiceToggle />` pill** in the sidebar (lives next to
  `<UsagePill />`). Three visual states keyed off the existing
  voice slice: green dot **VOICE ON** when healthy and the user
  hasn't disabled, amber dot **VOICE OFFLINE** when the user is
  on but the upstream's unreachable, muted dot **VOICE OFF**
  when the user has flipped it off. Tap toggles between off and
  on; subtext doubles as the affordance label ("tap to disable" /
  "tap to enable" / "upstream unreachable — tap to disable").
- **`set_voice_enabled { enabled: boolean }`** mutation — the
  agent can flip it from chat too. The system prompt vocabulary
  describes when to use it: explicit user statements like "turn
  off voice" / "voice on" / "I'm at home, voice on", not
  inferred from context.

Both routes write to a single `store/settings.json` file (new
storage module: `server/src/storage/settings.ts`). The settings
object is intentionally a tree — today only `voice.disabled` is
populated, but the read path shape-completes the object on every
load so future flags can land here without a separate file each.
Atomic temp-rename writes via the existing `writeJson` helper.

Three places observe the flag:

1. **`readVoiceHealth`** short-circuits before probing. When
   `voice.disabled` is true it returns `{available:false,
   disabled_by_user:true, stt:{ok:false, reason:"voice disabled
   by user"}, tts:{...}}` immediately. Off-LAN poll cost drops
   from ~8000ms to ~40ms.
2. **Voice POST endpoints** (`/v1/voice/transcribe`,
   `/v1/voice/synthesize`, `/v1/voice/spoken_for_text`) call a
   new `voiceUserDisabledGuard(res)` helper that fast-fails
   with HTTP 503 `{error:"voice disabled by user",
   disabled_by_user:true}` when the flag is set. `spoken_for_text`
   doesn't actually need the LAN (it calls `cursor-agent`) but
   gating it keeps the on/off semantics tight: voice off means
   no voice-related work runs, period.
3. **WS event `voice_settings_changed`** fires on every flip so
   all open clients re-poll `/v1/voice/health` immediately
   instead of waiting up to 5 minutes for the next periodic
   refresh. The store handler in `subscribeEvents` calls
   `refreshVoiceHealth` and lets the existing reconciliation
   path do the rest.

Smoke test (off-LAN, Orin unreachable):

```text
=== flip OFF ===
{"ok":true,"kind":"set_voice_enabled","result":{"voice":{"disabled":true}}}

=== health (40ms, no probe) ===
{"available":false,"disabled_by_user":true,"stt":{"ok":false,"reason":"voice disabled by user"},...}

=== synthesize ===
HTTP 503  {"error":"voice disabled by user","disabled_by_user":true}

=== flip ON ===
{"ok":true,"result":{"voice":{"disabled":false}}}

=== health (8039ms, real probe) ===
{"available":false,"stt":{"ok":false,"reason":"This operation was aborted"},...}
```

The 200× latency drop on health (40ms vs 8039ms) is the whole
point — when traveling, the user flips the toggle off and the
client never blocks on a doomed probe again. Flipping back on
re-engages the probe; if the LAN is reachable, the mic returns
within one poll.

Backlog: when on a metered/cellular network the user might want
the toggle off by default. We could persist a "preferred state
when health probe fails N times in a row" auto-suggest, but
that's a long way from useful — for now the explicit pill is
plenty.

### Phase 18 — Council as system decider ✅ shipped

> "The council will be for the agent to make choices, sure it's
> cool to see what they think but it's primarily for our system
> to make choices."

Until Phase 18, every approve gate was human-clicked: the council
returned a verdict, the user clicked Approve. That had two costs:
the agent kept telling users "click Approve on the X tab" instead
of conversing, and the system felt like it was waiting for a
button press at every step. The council was a juried debate, not
a decider.

Phase 18 flips it. The council *is* the system's decider; the
human is the override. Three changes:

**1. Auto-decide hook in the council runner.** After every
council run completes, `autoAdvance(run)` inspects the chair's
`overall_verdict` and fires the corresponding approve mutation
when it returns `approve` or `approve_with_notes`. On
`request_changes` the gate stays closed — the council said no.

The hook fires through a dynamic import of `applyMutation` to
break the static cycle (`applicators.ts` already imports
`getCouncilRunner`); failures are logged but never crash the
runner — the run record is on disk and the user can override
manually if the auto-decide trips. A new `council_auto_decided`
WS event surfaces the action so UI subscribers can show a
distinct toast ("council auto-approved your flow") instead of
confusing the user about who clicked Approve.

**2. New `architecture_review` council kind.** The only major
gate the council didn't touch was architecture approval. Phase
18 adds a project-scoped review (sentinel `feature_id: "_arch"`,
runs persisted under `store/<slug>/council/_arch/`) with five
hardcoded lenses tuned for system architecture rather than
feature flow:

| lens | charter focus |
|---|---|
| reliability | single points of failure, retries/timeouts/circuit breakers, sync deps on flaky externals |
| scalability | bottlenecks at 10× / 100× traffic, unsharded datastores, choke points |
| security | trust boundaries, authn/authz, secrets, blast radius, encryption in transit/at rest |
| cost | expensive components, redundancy that could consolidate, polling vs. webhooks |
| operability | observability seams, ownership, deployment coupling, runbook gaps |

Custom arch personas are deferred — these five concerns are
universal and don't benefit from per-project overrides the way
flow_review's product/marketing/legal lenses do.

New verb `request_arch_review { project_slug }` (agent-emittable)
queues the run; on chair approve the runner auto-fires
`approve_architecture`. Pre-condition: at least one service
must exist (otherwise the panel has nothing to evaluate).
Crucially, requesting a re-review of an already-approved
architecture does **not** auto-clear the existing approval —
task planning keeps working while the new review runs in the
background. If the new chair returns `request_changes`, the
existing approval stays put; the user can manually
`unapprove_architecture` if they want to act on the new findings.

**3. System prompt + coach hint rewrite.** The whole "USER decides;
do NOT call approve_* on the user's behalf" framing comes out.
The new framing is: agent emits `request_*_review` (or
`request_task_planning`), council decides, system advances.
Coach stages 4 (flow_review), 5–6 (architecture), 7
(flow_approved+arch_approved), and 8 (planning) all dropped the
"click Approve" language and now describe the council-driven
auto-advance path.

`approve_flow`, `approve_tasks`, `approve_architecture` still
exist as verbs but the system prompt now says "the council
fires this automatically — DO NOT emit it yourself; the only
legitimate use is for the user clicking a manual override in
the UI." The shape is the same; only the agent-author guidance
changed.

**Smoke verification** (testah project, 2 services with no
datastore / auth / observability):

- `unapprove_architecture` → re-fired `request_arch_review`.
- 5 arch lenses ran in parallel, completed in ~20s.
- 4/5 lenses returned `request_changes` (reliability,
  scalability, security, operability) citing missing TLS, no
  auth, no datastore, no observability. Cost lens returned
  `approve_with_notes` (not enough info to predict spend).
  Chair synthesized `request_changes` with 16 must_address
  findings — exactly what the lenses said.
- Auto-decide hook **correctly did not** fire
  `approve_architecture`. `approved_at` stayed `null`.

The negative test (auto-decide stays its hand on a real
`request_changes`) is more important than the positive — it
proves the council is a real decider, not a rubber stamp.

### Phase 16 — Coach hints (proactive guided flow) ✅ shipped

> "I want the AI to be asking questions the whole time basically
> walking the user through our flow, so basically all we have to
> do is have a convo with this thing and it will build."

Until now the agent was *reactive*: the user typed something, the
agent answered. New users had no idea where to start ("what should
I even ask?") and existing projects had no narrative thread —
nothing nudging the user from `draft → flowing → flow_review → arch
→ planned → running`. The system was fully featured but lonely.

Phase 16 makes the agent a **guided coach**. Every turn, before the
user's text hits the prompt, the server reads the current world
state for the active scope and injects a small directive block —
`[icarus coach — what to ask the user next]` — that translates the
state into the *next focused question*. The agent uses that hint
to drive the conversation forward when the user is exploratory or
silent, and ignores it when the user steers in a different
direction.

**Scope-aware stages:**

- **Global, no projects** → "what does the user want to build?"
  Get a name + one-line description, emit `create_project`,
  `navigate` them into the new project chat.
- **Global, has projects** → "do you want to start something new
  or pick up an existing one?" Emit `navigate` if they pick,
  `create_project + navigate` if they start fresh.
- **Project, no features** → "what's the first feature?"
  After it lands, propose walking through the user flow.
- **Project, draft feature, no flow** → "walk me through the user
  journey." Emit `add_flow_node` + `add_flow_edge` as they describe
  it; propose `request_flow_review` when they say it's complete.
- **Project, draft feature, partial flow** → "anything missing?
  edge cases? error paths?" Keep adding; same review proposal.
- **Project, flowing** → "ready to send to the council?" Emit
  `request_flow_review` after they confirm.
- **Project, flow_review** → "council ran — verdict's on the
  Council panel. Click Approve Flow when you're happy." Never
  emits `approve_flow` itself.
- **Project, flow_approved + arch empty** → "what services /
  datastores / external integrations does this need?" Draws
  services + edges; tells user to click Approve Architecture.
- **Project, arch drafted but not approved** → "click Approve on
  the Architecture tab; task planning is blocked until then."
- **Project, flow_approved + arch_approved** → "want me to plan
  the tasks?" Emits `request_task_planning` after confirm.
- **Project, planning** → "council is generating tasks; check the
  Tasks tab and approve the ones you want." Never emits
  `approve_tasks` itself.
- **Project, planned/in_progress** → "want me to start the
  queue?" Emits `start_queue` after confirm; surfaces in-flight
  tasks if the queue is already running.
- **Project, mixed/done** → no specific question; just hold the
  conversation.

**Golden rules baked into every hint** (read by the agent on every
turn so they don't drift):

- **One focused question per turn.** No barrage. Wait for an
  answer, advance.
- **Follow the user's lead.** If they ramble about implementation,
  ask a question, or jump around the flow, follow them — the hint
  is guidance, not a script.
- **User-owned verbs stay user-owned.** `approve_flow`,
  `approve_architecture`, `approve_tasks` are *proposed*
  conversationally ("click Approve on the Flows tab when you're
  happy") — the agent never emits them on the user's behalf,
  matching the long-standing rule in the system prompt.

**Plumbing** is one new module + a 6-line addition to `buildPrompt`:

- `server/src/coach/hint.ts` — `computeCoachHint(scope)` reads
  fleet / features / flows / tasks / architecture from disk and
  picks the matching stage. Cheap (one disk read per turn).
- `server/src/chats.ts` — `buildPrompt` now appends the hint
  immediately before the user text, after the project context
  preamble. Hint is descriptive of state ("partial flow, 3 nodes,
  2 edges") and prescriptive of action ("ASK: anything missing?").

Smoke verification (curl against a freshly built server):

- Fresh global chat with one existing project → agent says
  *"You already have a project called testah. Do you want to open
  that and work inside it, start something brand new, or are you
  just saying hello? If you want to jump straight into testah, say
  something like 'open testah' and I'll route you there."*
- Fresh project chat with feature in `flow_review` → agent says
  *"Your Eat cake feature is in flow review: the council has run,
  so the place to look is the Council panel. If the flow looks
  right, use Approve Flow on the Flows tab — that's your step to
  move it forward; I won't approve it for you."*

Both responses came from the agent, not a template. The coach hint
shaped the question; the agent rendered it in its own voice.

**Why this is enough (no auto-kickoff in v1):** auto-firing a turn
on chat creation would burn one cursor-agent invocation per chat
even when the user isn't ready to talk. Instead we leaned on the
existing system: the user types anything ("hi", "let's go", "ok")
and the coach takes over from the first response. The empty-chat
state is unchanged (just the prompt placeholder); the coach
behavior turns on the moment the user speaks. If we want a "Walk
me through it" button later, it can dispatch a synthetic message
without code changes server-side.

---

## What we're explicitly *not* building (yet)

- **Multi-user / accounts.** Single user, single host. Adding auth later is
  cheap when the data shape is files on disk.
- **Mobile-native (Swift/Kotlin).** Web only. Expo's there if we want it
  later, but design + ship for the browser.
- **Verification workers** (auto-run task tests). The `verification_*` task
  fields stay in the schema for forward-compat but nothing reads them.
  (`run_tests` as a Phase-10 tool is a manual, on-demand version of this.)
- **Embedding-based RAG.** Cursor-agent's native code tools (read, grep,
  glob) cover code awareness. Project metadata gets prompt-stuffed. We add
  embeddings only when we feel the limits — likely never for one user.
- **Background autonomy outside cron.** The "go" loop only runs when you
  explicitly start it. Cron jobs (Phase 11) only do what you explicitly
  scheduled.
- **Importing data from the source repo.** Clean break.

---

## UI design (sci-fi futuristic)

Aesthetic target: a dark ops console you'd see on a starship bridge.
Beautiful, dense, glowy where it matters, calm where it doesn't.

**Design tokens (canonical, used everywhere):**
- Background: deep navy → near-black vertical gradient (`#05070d` →
  `#0b0f1c`), with a very subtle 1px grid overlay (`rgba(180, 220, 255,
  0.03)`) for "HUD" texture.
- Surface (panels, cards): `rgba(15, 22, 38, 0.72)` with 12px backdrop
  blur and a 1px translucent cyan border `rgba(120, 220, 255, 0.18)`.
- Primary accent: electric cyan `#5cf6ff`. Used on focus rings, active
  states, primary CTAs.
- Secondary accent: neon violet `#b78bff`. Used on council / planning
  artifacts (verdicts, proposed tasks).
- Warning / blocked: amber `#ffb454`.
- Success / done: phosphor green `#76f5b0`.
- Text primary: `#dde6f5`. Text secondary: `#7a89a8`. Text muted: `#506074`.
- Fonts: **Inter** for body and chat. **JetBrains Mono** for timestamps,
  IDs, status codes, code snippets, and section headings (small, wide
  letter-spacing — gives the "instrument readout" feel).
- Glow: every interactive accent has a soft outer glow on hover/focus
  (`box-shadow: 0 0 16px <accent>40`). Not on every element — chosen
  signal moments: send button, "Approve flow" CTA, the "▶ Run queue"
  button, the live ticker pulse.
- Motion: 150ms ease for hovers, 220ms ease-out for panel transitions.
  Streaming text has a single trailing caret with a 800ms blink.

**Components (per-element direction):**
- **Chat composer**: full-width pill, monospace placeholder ("// type to
  command icarus…"), send button is a glowing arrow.
- **Message bubbles**: assistant = surface-tone with cyan left border;
  user = subtle cyan-tinted surface with violet right border. No avatars.
- **Action pills** (inline command markers): dark capsule with a tiny
  status icon (`▶` preparing, `✔` applied, `✗` rejected). Glow color
  matches state.
- **Question cards**: amber left border, monospace task id header, a
  prominent "Reply" button.
- **Kanban columns**: thin cyan headers with monospace count badges, cards
  with a state-colored left edge, drag preview leaves a glow trail.
- **Flow canvas**: dark grid background, nodes are translucent capsules
  with an accent-colored hairline; edges glow softly when selected.
- **Council verdict panel**: 5-up grid of lens cards, each lens has its
  own faint accent (Product = cyan, Architect = violet, Engineer = amber,
  UX = pink, QA = green). Chair summary at the bottom in a monospace
  block, like a status report.
- **Ticker** (running tasks): a bottom strip with task names scrolling
  slowly, a pulsing cyan dot per active worker.

**Layout:**
- Mobile-first, single-pane. Drawer for sidebar (chats, projects).
  Bottom-anchored composer. Sticky tab bar inside project pages.
- Web: 3-column on wide screens (sidebar | content | side panel for
  council/questions), collapses gracefully.
- Density: tighter than a marketing site, looser than a terminal.
  16px base unit; 8px / 12px / 16px / 24px rhythm.

**Don't do:**
- No skeuomorphic chrome, no 3D bevels, no glassmorphism for its own
  sake. Subtle blur on real layered surfaces only.
- No animated stars, scanlines, or "matrix rain." Sci-fi *implied*, not
  costumed.
- No more than three glow colors visible at once. Restraint is what
  makes the glow read as intentional.

We seed these tokens in Phase 0 (theme module + adoption in the existing
chat UI). Subsequent phases pick up the same tokens for new surfaces.

---

## Decisions locked in

- **Storage location** = `./store/` in the repo, override via `ICARUS_DATA`.
- **Default models** = global chat `ask`, per-project chat `agent`, queue
  runner `agent --force`, council passes `agent` (no `--force` needed,
  council never edits files).
- **Code tab** = read-only with syntax highlighting in v1; editable in v2.
- **Project workspace_path on create** = three modes offered:
  (a) pick an existing folder, (b) leave null for planning-only projects,
  (c) auto-create a new folder under `WORKSPACE_DIR/<slug>` and `git init`
  it. UI shows a 3-way radio with sensible defaults per case.
- **Questions** = hybrid. First-class records in `questions.json` *and*
  injected into the relevant chat as a question card. Inline reply or
  Inbox reply both produce `answer_question`.
- **Persistent chat history** = yes, on disk, reloads on startup.
  Sidebar lists past chats; click to resume; resume uses
  `cursor-agent --resume <chat_id>`.
- **Council Flavor 2 in v1** = single multi-lens `cursor-agent` call.
  Upgrade to 5-parallel-runs + Chair in Phase 9.
- **Flow approval** = the user is *always* the final gate. Council never
  auto-applies `approve_flow`; the verdict panel always requires an
  explicit "Approve flow" click. Approval of *tasks* is the same — user
  reviews proposed tasks and clicks "Approve plan."
- **Stale tasks** = when an approved flow gets edited, all derived tasks
  become `stale` and immediately ineligible for the "go" queue. The
  feature page shows a "Replan" button that re-runs task-planning council
  against the new flow. A per-task "still valid" override exists for
  one-off cases where the edit doesn't affect a specific task.
- **Council quorum** = none. Lenses are advisory. The user reads the
  panel and decides. No 3/5 logic, no chair veto.
- **Tools and Cron** = scoped as Phase 10 and Phase 11, **parked in the
  backlog** until the rest of the system is built. Tools are
  parametrized prompt templates that run via `cursor-agent` against a
  project workspace. Cron schedules tool runs, task starts, or queue
  starts. Tasks can carry a `tool_id` so cron-triggered work is
  declarative. We don't dwell on them until Phase 9 ships.
- **Global chat scope** = the global chat can issue *any* command,
  including project-scoped ones (with `project_slug` in payload). The
  per-project chat is just *more focused*: it defaults the slug for you
  and stuffs only that project's context. No artificial gating between
  the two.
- **UI aesthetic** = dark sci-fi console (see UI design section above).

## Backlog (decide later, parked for now)

- Code browser: syntax highlighting + live-diff overlay.
- Cross-process queue heartbeats / lease reaping (only needed when we
  scale beyond a single Node process).
- Automated test harness (Vitest/Jest).
- `ToolProposal.source` backlinks in the suggestions banner.
- Native (iOS/Android) recorder via `expo-audio`. The web recorder
  uses `MediaRecorder`; native is hidden until we wire the Expo
  module + permissions UI. Voice quality bar is the same on both.
- *(done — moved out of backlog; see "STT on GPU" under
  Operational notes for build details and benchmarks.)*

---

## Status

Phases 0–22 are shipped. The rest of this doc is the contract.

- ✅ **Phase 0** — Disk-backed core (chats, mutations, sci-fi theme)
- ✅ **Phase 1** — Project shell (global + per-project chats, sidebar,
  activity feed)
- ✅ **Phase 2** — Command protocol (chat-emits-commands, pills, schema
  retry loop, memory observation)
- ✅ **Phase 3** — Features + flow canvas + tasks (read+draft)
- ✅ **Phase 4** — Council + flow→tasks pipeline (with stale-on-edit)
- ✅ **Phase 5** — Autonomous "go" queue + Questions hybrid UI
- ✅ **Phase 6** — Kanban / features-list polish
- ✅ **Phase 7** — Read-only code browser (syntax highlight + diffs
  deferred)
- ✅ **Phase 8** — Architecture canvas
- ✅ **Phase 9** — Multi-slot parallel queue (leases + resource_scope)
  and 5-parallel + chair council runner
- ✅ **Phase 9.5** — Architecture gate before tasks (`approved_at`
  with auto-invalidate on semantic edits), chat agents emit edges as
  well as nodes (label-form on edge endpoints), inline workspace
  setup on the Code tab (`update_project`)
- ✅ **Phase 10** — Tools (reusable parametrized `cursor-agent`
  skills, Mustache-lite renderer, tool-backed tasks, global Tools tab)
- ✅ **Phase 10.1** — Tools-as-API (stable slugs, callable HTTP
  surface at `POST /v1/tools/<slug>/run` with sync `wait=true` and
  async polling via `GET /v1/tool_runs/<run_id>`, in-process event
  bus listeners)
- ✅ **Phase 11** — Cron (5-field crontab matcher, minute-tick
  scheduler, `tool` & `queue` targets, run-now, global Cron tab)
- ✅ **Phase 11.1** — Cron `task` target (recurring raw task
  creation; `auto_start` flag for fire-on-tick vs land-in-backlog;
  cron editor's target picker is now 3-way Tool/Queue/Task; two-
  stage scheduler dispatch reuses `add_task`+`start_task`)
- ✅ **Phase 12** — Rules (free-form markdown guidance, two scopes
  global + per-project, prepended to every cursor-agent run across
  chat/queue/council/tools, `formatRulesBlock` injection helper, four
  mutation verbs with optional fast-path scope, Rules tab on global +
  per-project, agent vocabulary updated so the agent itself can
  author rules from chat)
- ✅ **Phase 13** — Tool auto-suggestion (agent emits `propose_tool`
  mid-stream when it notices repeatable work; pending proposals
  surface as a banner on the global Tools tab + count badge on the
  tab pill; accept opens the editor pre-filled, save creates a real
  Tool and stamps `tool_id` on the proposal; reject soft-deletes;
  conservative-by-default emit guidance in the system prompt)
- ✅ **Phase 14** — Custom council personas (data-driven flow-review
  panel; `Persona.key` doubles as the lens slot id; matching a default
  key replaces, any other key adds; two scopes — `global_and_project`
  with project beating global beating default; council runner now
  iterates `resolveCouncilPersonas(project_slug)` instead of a hard-
  coded `LENS_IDS`; lens schema relaxed to `z.string()` with
  parser-side membership check; new global + per-project Personas
  tabs with provenance pills on the resolved panel; `create_persona` /
  `update_persona` / `archive_persona` are agent-callable verbs)

- ✅ **Phase 15** — Voice commands & navigation (push-to-talk that
  STT-transcribes via the Orin's Faster-Whisper, confirm-first
  preview bubble with edit / re-record / discard, agent-mediated
  `navigate` mutation that broadcasts a `nav_request` WS event
  filtered by `client_id`, sentence-chunked TTS playback via the
  Orin's XTTS-v2, transient task highlight on `kind:"task"` nav,
  per-lens persona accent painted on each verdict card)
- ✅ **Phase 15.1** — Spoken summaries (long voice replies are
  routed through `POST /v1/voice/spoken_for_text` which
  passthrough-speaks short replies, fires a cursor-agent summary
  for long ones, or deterministically truncates on summary
  failure; mid-stream sentence playback dropped in favor of a
  single fetch-then-feed at turn-end, generation-guarded so a
  re-armed mic mid-fetch drops the stale audio cleanly)
- ✅ **Phase 15.2** — Voice-answered questions (each open
  question card gets a SPEAK & ANSWER button that reads the
  question body aloud and locks the global voice target; the
  next confirmed transcript fires `answer_question` instead of
  going to chat. Preview bubble surfaces a "→ ANSWERING: <q>"
  banner so the user can't miss where their utterance is
  going. Target auto-resets on confirm/discard/cancel, and a
  ✕ on the floating banner clears it manually. Typed answers
  via the existing inline reply box are unchanged — the voice
  loop is purely additive.)
- ✅ **Phase 16** — Coach hints (proactive guided flow). New
  `server/src/coach/hint.ts` module reads the live world state
  for the active scope and renders a `[icarus coach]` directive
  block, prepended to every cursor-agent turn just before the
  user text. Nine state-driven stages (no projects → no
  features → draft no flow → draft partial flow → flowing →
  flow_review → flow_approved+arch_empty → arch_drafted+
  unapproved → flow_approved+arch_approved → planning →
  planned). Two golden rules baked into every hint: "one focused
  question per turn" and "follow the user's lead — this is
  guidance, not a script." User-owned approve verbs are still
  proposed conversationally and never emitted by the agent.
  Auto-kickoff on chat creation deferred — the coach engages on
  the user's first message, no LLM cost when the user isn't
  ready to talk.)
- ✅ **Phase 17** — Cursor usage panel (`server/src/cursor_usage/`
  reads desktop SQLite JWT via `sqlite3` CLI, refreshes via
  Auth0 `/oauth/token` in-memory only, calls undocumented
  `api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage`
  + `GetPlanInfo`; `GET /v1/cursor/usage` returns ok/unavailable
  envelope with 5-min cache + force-refresh; sidebar `<UsagePill />`
  with cyan/amber/rose progress gauge, plan name, percent,
  $-included spend, days-left-in-cycle, optional bonus credit
  line; ro Docker bind on `~/Library/Application Support/Cursor`
  with `CURSOR_DESKTOP_HOST_DIR` override for Linux/Windows;
  refresh tokens are deliberately NOT written back to the
  desktop store so we can't corrupt Cursor's auth state.)
- ✅ **Phase 18** — Council as system decider. `autoAdvance(run)`
  hook in the council runner inspects the chair's
  `overall_verdict` after every completed run and fires
  `approve_flow` / `approve_tasks` / `approve_architecture`
  automatically on `approve` / `approve_with_notes`; `request_changes`
  leaves the gate closed. New `architecture_review` council kind
  with five hardcoded lenses (reliability, scalability, security,
  cost, operability) — project-scoped (sentinel feature_id
  `_arch`), triggered by new `request_arch_review` verb, runs
  N-parallel like flow_review and reuses the same chair-synthesis
  pattern. New `council_auto_decided` WS event for UI toasts.
  System prompt + coach hint rewritten to drop "click Approve"
  language; agent routes everything through `request_*_review`
  and `request_task_planning`. User can still manually
  `unapprove_architecture` (and edit the flow / archive tasks)
  to override any council decision after the fact. Smoke-tested
  on a thin 2-service architecture: 4/5 lenses requested changes
  citing missing TLS / auth / datastore / observability, chair
  synthesized `request_changes` with 16 must_address findings,
  auto-decide hook correctly DID NOT fire `approve_architecture`
  — proving the council is a real decider, not a rubber stamp.)
- ✅ **Phase 19** — Voice user toggle. New
  `server/src/storage/settings.ts` reads/writes
  `store/settings.json` with shape `{voice:{disabled:boolean}}`;
  `readVoiceHealth` short-circuits to `{available:false,
  disabled_by_user:true}` without probing when the flag is set
  (40ms vs 8s+ when off-LAN). Voice POST endpoints
  (`transcribe`/`synthesize`/`spoken_for_text`) all fast-fail
  with HTTP 503 via a shared `voiceUserDisabledGuard`. New
  `set_voice_enabled { enabled }` mutation lets the agent flip
  it from chat too; new `voice_settings_changed` WS event so
  all open clients re-poll health immediately. Sidebar
  `<VoiceToggle />` pill renders three states (green ON·healthy
  / amber ON·offline / muted OFF·user) keyed off the existing
  voice slice, no extra polling. Threaded `userDisabled` through
  the voice store slice so the off-state is distinct from the
  upstream-unreachable state.
- ✅ **Phase 20** — Per-role cursor-agent model selection. Extended
  `Settings` with `models: { chat: string, agent: string }`, defaults
  `composer-2` / `claude-opus-4.7`. New `modelFor(role, envFallback)`
  helper called per-invocation in `chats.ts` (chat path), `voice/spoken.ts`
  (voice spoken-summary), `queue/worker.ts` (autonomous tasks), and
  `council/runner.ts` (lens reviews + chair) — each picks the right model
  with no in-memory cache to invalidate. New `set_models { chat?, agent? }`
  mutation routes through the same applicator pipeline so the agent can
  flip from chat ("switch chat to composer 2"); empty string resets to
  default. New `GET /v1/settings/models` read endpoint and
  `model_settings_changed` WS event so all open tabs re-render the
  Settings dropdowns together. New "SETTINGS" tab on the global cockpit
  (rightmost, alongside CHAT/TOOLS/CRON/RULES/PERSONAS) renders two
  grouped radio-style dropdowns (Conversational / Autonomous), each
  showing label + hint + raw slug; if a persisted slug isn't in the
  curated catalog (env-set, etc.) it surfaces as a synthetic "Custom"
  entry so we don't silently overwrite it.
- ✅ **Phase 21** — Voice endpoint hot-swap + nav races + voice contract
  doc. Three orthogonal fixes shipped together:
  - **Voice hot-swap.** Extended `Settings.voice` with `stt: { url,
    auth }` and `tts: { url, auth, voice, language }` so users can
    point icarus at a different STT/TTS provider without editing
    `.env` and restarting. `readVoiceConfig` is now async and layers
    settings → env → built-in default; new `source` provenance flag
    surfaces "settings"/"env"/"unset" in the UI. Auth tokens are sent
    as `Authorization: Bearer <token>` (helper `authHeaders` reused
    by health probe + STT + TTS). New `PATCH /v1/settings/voice`
    handles full config including auth (write-only — read returns
    `"***"` for set tokens; `"***"` round-trips as a no-op so the form
    can be saved without re-pasting secrets); new `set_voice_endpoints
    { stt_url?, tts_url?, voice?, language? }` mutation lets the agent
    swap URLs from chat (deliberately omits auth fields — chat history
    is the wrong place for Bearer tokens). New "Voice APIs" section in
    the Settings tab with form fields, source badges per upstream,
    "live: …" hints showing the resolved value, and SAVE / CLEAR ALL
    actions. New `docs/VOICE.md` documents the icarus voice contract
    (3 endpoints), drives the agent + human plug-in path, and includes
    worked examples wrapping OpenAI Whisper + ElevenLabs.
  - **Nav after create — same-turn agent flow.** Extended
    `NavigateTarget` so each kind accepts either an id form
    (`project_slug` / `feature_id` / `task_id`) OR a name form
    (`project_name` / `feature_name` / `task_name`). The agent gets
    new ids in pendingMemory only on the *next* turn, so name-form is
    the escape hatch for "create X and navigate to X" within one turn.
    Resolution is server-side in `resolveNavigateTarget`: case-insensitive
    name match, most recent `created_at` wins on tie, archived projects
    excluded. The broadcast event always carries the *resolved* (id-form)
    target so client handlers stay untouched; the result echoes both
    `requested` (label form) and `target` (resolved) for activity-log
    audit. System prompt rewritten with the new vocabulary + worked
    examples for create-and-navigate flows.
  - **Nav after create — client-side dead composer.** Refactored
    `refreshChats` to self-heal: if the active chat for the current
    scope is null OR no longer in the list (e.g. brand-new project,
    other tab archived a chat we had cached), pick the most recent
    existing chat or `newChat()` if the list is empty. Closes the
    "navigate to fresh project → composer disabled forever" UX bug
    that affected both user-driven (NEW PROJECT button) and
    agent-driven (`create_project` + `navigate`) flows. Also extended
    the global Settings tab to the schema (`GlobalTab` adds
    `"settings"`).
- ✅ **Phase 22** — JWT auth (single-tenant, self-hosted). Added a
  `server/src/auth/` module backed by `aerekos-record` + `sqlite3` for
  the users table (`<dataRoot>/auth.sqlite`), `bcryptjs` for password
  hashing, and `jsonwebtoken` for HS256 token signing. JWT secret
  resolution is layered: `JWT_SECRET` env var → `<dataRoot>/.jwt-secret`
  (auto-generated on first boot, `0600` perms, gitignored via the
  existing `store/` rule). On first boot the server seeds an `admin` /
  `changeme` bootstrap user with `must_change_password: true`, logs the
  fact loudly, and refuses every protected route until the password is
  changed. New endpoints: `POST /v1/auth/login`, `GET /v1/auth/me`,
  `POST /v1/auth/change-password` (re-issues a fresh token with the
  must-change claim cleared), `POST /v1/auth/logout`. `requireAuth`
  middleware mounted globally with `/health` + `/v1/auth/login` as the
  only public paths; `requireMutablePassword` layered on top so the
  must-change tripwire 403s every other route until cleared.
  WebSocket `/v1/events` upgrade is gated server-side via a custom
  `noServer: true` upgrade handler that pulls `?token=…` from the URL
  and validates with the same `verifyToken` helper — bad/missing
  tokens get a `401 Unauthorized` and the socket never opens. Client
  side: `app/src/auth.ts` owns token storage (`localStorage` with a
  safe RN/web shim), `subscribeAuth` listeners, and an `authFetch`
  wrapper that pins `Authorization: Bearer <jwt>` and clears local
  state on any 401. `api.ts` routes every request through `authFetch`
  (35 call sites switched in one bulk edit). `events.ts` reads the
  token at WS connect time and reconnects/closes in lockstep with
  auth state changes. New `app/src/components/AuthScreen.tsx`
  (LoginForm + ChangePasswordForm sharing a single sci-fi shell);
  `App.tsx` is now a 3-state gate — login → forced change → main.
  Sidebar grew an "ACCOUNT" pill at the bottom showing the
  authenticated username with `change pw` / `sign out` actions
  (manual change-pw routes back through `<AuthScreen />` in
  non-forced mode so users can rotate without logging out).
  Server Dockerfile bumped to install `python3 make g++` so
  `better-sqlite3`'s native bindings can build inside the runtime
  image when the prebuild isn't available for the target arch.
  Smoke-tested end-to-end via `curl`: unauthed → 401, login →
  token+user, must-change tripwire blocks `/projects` with
  `must_change_password: true`, change-password reissues a fresh
  token, post-change `/projects` returns 200, weak password → 400
  `weak_password`, wrong creds → 401 `invalid_credentials`. WS
  upgrade verified via a small Node ws client: bad/missing token
  → 401, valid token → open + initial ping. Full contract in
  `docs/AUTH.md`. README quickstart now points to the bootstrap
  creds and links the auth doc; `.env.example` carries the new
  `JWT_*` / `AUTH_*` env vars.

**Operational notes:**
- **Voice on macOS requires native server.** Docker Desktop on
  macOS can't route container traffic to LAN peers (verified
  empirically — even with `HostNetworkingEnabled: true` and
  `--network host`, the container ends up in the Linux VM's
  namespace, which gvisor/vpnkit firewalls off from the Mac's
  physical subnet). Run `cd server && ./scripts/dev-native.sh`
  on the Mac while keeping the `app` container in Docker. The
  launcher sources `../.env` and fills in native path defaults.
  See README "Heads up — Docker Desktop on macOS LAN access".
- **Container→native pivot mid-flight: stale `workspace_path` in
  fleet.json.** Projects created while the server ran in Docker
  stamped *container* paths like `/workspace/<slug>` into
  `fleet.json`. After moving the server to native those paths
  don't exist on the host, so `spawn(cursor-agent, ..., { cwd })`
  fails to `chdir()` and Node mis-reports it as `spawn cursor-agent
  ENOENT` (it's the cwd that's missing, not the binary).
  `chats.ts::resolveProjectCwd` translates legacy `/workspace/X`
  paths to `${WORKSPACE_ROOT}/X` on the fly with a console.warn
  pointing the operator at `update_project`; pure native
  projects use the host path directly. The route handler also
  logs ENOENT/ENOTDIR/EACCES with full context now (cwd, binary,
  syscall, exists check) so future opaque-spawn-errors
  self-debug from the server log instead of vanishing into the
  SSE pipe.
- **STT on GPU (Whisper `large-v3-turbo` on Orin's CUDA).** The
  PyPI `ctranslate2` aarch64 wheel is CPU-only and the Jetson AI
  Lab `cu126` overlay turned out to be a transparent PyPI proxy
  (no Jetson-built CUDA wheels — only `cu129` has a custom 4.6.0
  build, but Orin runs CUDA 12.6 so the wheel-vs-runtime skew
  isn't worth it). Fix: from-source build of ctranslate2 with
  `-DWITH_CUDA=ON -DWITH_CUDNN=ON -DWITH_MKL=OFF
  -DOPENMP_RUNTIME=COMP` (CMake flags from upstream PR #2019,
  tested on Orin Nano + JetPack 6). The Dockerfile at
  `<your-jetson>:~/work/tools/stt-service/Dockerfile` (sister
  repo) is now multi-stage — builder clones
  `OpenNMT/CTranslate2` at `v4.7.1` with
  `--recursive`, runs the cmake/make/make-install dance, builds
  the python wheel with `python setup.py bdist_wheel`. Runtime
  stage installs only the wheel + `libctranslate2*` shared libs,
  then `pip install -r requirements.txt` (faster-whisper sees
  ctranslate2 already satisfied so it doesn't pull the CPU wheel
  from PyPI on top — the bug we hit on the previous attempt).
  Build is ~15 min on Orin (CUDA NVCC compilation is the bulk).
  Final image is 10.4 GB (vs ~3 GB for CPU-only — the CUDA libs
  add ~7 GB; multi-stage already drops the build toolchain).
  Cmake's "Automatic GPU detection failed" warning is benign:
  Docker BuildKit doesn't expose a GPU at build time, so the
  build falls back to compiling kernels for "common
  architectures" (works on Orin's compute capability 8.7).
  Verified: `c.get_cuda_device_count() == 1`,
  `compute_type=float16` auto-selected, all CUDA compute types
  available. Latency for a 4s English speech clip:
  ~1.3-1.4s warm (~3x real-time, the expected GPU number). The
  first run after container restart is ~14s (CUDA kernel JIT +
  model load into GPU memory) — one-time cost.

**Parked in backlog** (revisit on demand):
- Add a real Jarvis voice clip to the upstream TTS voices
  directory (e.g. `tts-service/voices/jarvis.wav`); currently the
  reference config uses `default.wav`. Once a real clip is added
  and the service is bounced, flip `.env` to
  `VOICE_TTS_VOICE=jarvis`.
- Code browser: syntax highlighting + live-diff overlay.
- Cross-process queue heartbeats / lease reaping (only needed when we
  scale beyond a single Node process).
- Automated test harness (Vitest/Jest) — currently everything is
  curl smoke + `tsc --noEmit`. Worth doing before contributors.
- `ToolProposal.source` backlinks in the suggestions banner ("see
  where this came from" link to the originating chat/task).
- Native (iOS/Android) recorder via `expo-audio`. The web recorder
  uses `MediaRecorder`; native is hidden until we wire the Expo
  module + permissions UI. Voice quality bar is the same on both.
- Agent-authored spoken channel for Phase 15.1 — let the agent
  emit a `set_spoken_summary` mutation (or `<icarus-spoken>`
  fence) that overrides the server's auto-summary for the
  current turn. Skipped in v1 because it needs a new mutation
  kind + chat-pill filtering UX work to keep the override out
  of the visible reply. Auto-summary covers the pain alone.
- Auto-kickoff for Phase 16 — fire a synthetic agent turn the
  moment a chat is created (or first viewed empty) so the user
  sees a coach question without typing anything. Skipped in v1
  to avoid burning a cursor-agent invocation per accidentally-
  created chat; the coach engages on the user's first message
  instead. If we want it later, a "Walk me through it" button
  in the empty-chat state is the cheapest way in (one button
  click → synthetic "(start)" message → coach takes over).
- Coach aggressiveness toggle for Phase 16 — currently always-
  on. If we ever find the agent is forcing coaching questions
  when the user just wants to chat, expose a per-chat or per-
  scope dial (off / gentle / always-on) rather than rewriting
  the hint logic.
- Custom architecture-review personas (Phase 18 follow-up) —
  the five baked-in lenses cover universal arch concerns but
  the persona registry could resolve a separate set for
  `architecture_review` if we ever want per-project arch lenses
  (e.g. "compliance" for regulated workloads, "data-engineering"
  for analytics-heavy projects). Skipped in v1 because none of
  the obvious extensions felt important enough to justify the
  registry plumbing.
- Token write-back for Phase 17 — currently the refreshed JWT
  lives in memory only; on long server runs we re-refresh
  whenever the cached token expires. If we ever want the
  desktop's SQLite to stay in sync (so Cursor desktop picks up
  fresh tokens too), we'd need careful concurrency around the
  shared file. Not worth it for the usage pill alone.
- Linux/Windows desktop path autodetect for Phase 17 — currently
  `CURSOR_DESKTOP_HOST_DIR` is the override. If contributors
  start running icarus on those OSes we should autodetect the
  Cursor user-data dir.
