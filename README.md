# icarus

Mobile-first replacement for Cursor Desktop. The brain is the local
[`cursor-agent`](https://cursor.com/install) CLI, driven by structured
prompts that emit JSON commands. The server applies those commands to a
disk-backed store of projects, features, flows, tasks, architecture, and
chats. The UI is React Native (Expo) so the same code runs in the
browser and on iOS/Android.

```
                     +-----------------------------+
                     |        icarus app           |
                     |  global chat | per-project  |
                     |  features | flows | tasks   |
                     |  arch | code | questions    |
                     +-----------------------------+
                                 ^   |
              SSE chunks         |   | HTTP (mutations) + WS (live)
                                 |   v
        +-------------------------------------------------+
        |                  icarus server                  |
        |  parser → applicator → JSON store + WS fanout   |
        |  per-project locks, council, queue worker       |
        +-------------------------------------------------+
                                 |
                                 v
                        cursor-agent CLI
        (one chat session per chat ID; one run per task)
```

The full design contract lives in [`plan.md`](./plan.md).

## What's in here

- **Global chat** that can do things — create projects, file tasks,
  edit features, sketch flows / architectures — by emitting structured
  `icarus` JSON command blocks alongside its prose. The server parses,
  validates, applies, and re-prompts on bad payloads.
- **Per-project chat** with the same vocabulary but pre-scoped to one
  project. Project context (features, flows, tasks, architecture
  approval state) is stuffed into every turn.
- **Lifecycle gates** — features go through
  `draft → flowing → flow_review → flow_approved → planning → planned →
  in_progress → done`. The Council (5-lens parallel review +
  synthesizing chair) helps draft and critique flows; the user
  approves. Architecture must be approved before tasks can be planned.
- **Autonomous "go" queue** with multi-slot parallelism and
  `resource_scope` leases. Press start; the worker picks up tasks,
  runs `cursor-agent` against each project's workspace, and only stops
  to ask questions through the Questions inbox.
- **Code browser** for each project's `workspace_path`. Read-only
  in v1; live-diff overlay deferred.
- **Architecture canvas** — services + edges, with an explicit
  approval gate that blocks task planning until the architecture is
  signed off.
- **Tools** — reusable parametrized `cursor-agent` skills authored as
  `{{var}}` Mustache-lite prompt templates. Run a tool against any
  project and the queue worker handles it like a normal task; the
  worker uses the rendered template instead of the generic prompt.
  Authored from the **Tools** tab on the global cockpit. Each tool
  has a stable `slug` and is callable as an API at
  `POST /v1/tools/<slug>/run` (sync `wait=true` or async polling via
  `GET /v1/tool_runs/<run_id>`).
- **Cron** — schedule tools, queue starts, or **recurring tasks** on
  standard 5-field crontab expressions (with handy presets in the
  editor). Three target kinds: `tool` (fires a Tool against a
  project), `queue` (kicks the worker), and `task` (creates a fresh
  backlog task on every tick — with optional `auto_start` to dispatch
  it immediately). The scheduler ticks once a minute, dispatches
  matches via the same applicator path the chat / UI use, and
  surfaces last-run status on every job. Authored from the **Cron**
  tab on the global cockpit.
- **Rules** — free-form `AGENTS.md`-style guidance (markdown bodies)
  prepended to every `cursor-agent` prompt. Two scopes: global rules
  apply across every project, project rules stack on top when the
  active scope is that project. Authored from the **Rules** tab on
  the global cockpit and per-project view; agent-authored too via the
  `create_rule`/`update_rule` mutation verbs.
- **Tool auto-suggestion** — when the agent notices it just did
  something with a clear repeatable shape, it emits a `propose_tool`
  pill mid-turn. Pending suggestions render in a banner at the top of
  the **Tools** tab (with a count badge on the tab pill). Accept
  opens the tool editor pre-filled — tweak name/slug/description,
  hit save, and a real Tool is materialized; reject soft-deletes.
  The system prompt's emit guidance is conservative-by-default: only
  parametrizable, repeatable work qualifies.
- **Custom council personas** — the council's flow-review panel is
  now data-driven. Default lenses (`product`, `ux`, `architecture`,
  `security`, `operability`) ship in a registry; a `Persona` with a
  matching `key` *replaces* that lens for its scope, and any other
  `key` (e.g. `marketing`, `legal`) *adds* a new lens. Two scopes:
  global (every project) and project (this project only); project
  beats global beats default. Authored from the **Personas** tab on
  the global cockpit and per-project view, with a resolved-panel
  preview that labels each slot with its provenance. Agent-authored
  too via `create_persona` / `update_persona` / `archive_persona`.
- **Voice commands & navigation** — push-to-talk mic button
  (floating, bottom-right) wraps a self-hosted Whisper STT + Coqui
  XTTS-v2 TTS pair on the LAN. Click to arm, click again to stop;
  the transcript surfaces in a **preview bubble** so you can
  confirm what was heard before anything is sent. From there: hit
  Send (or Enter) to fire it into the active scope's chat,
  click the mic again to redo (replaces — the "talk to change
  it" path), edit inline if Whisper mishears a proper noun, or
  hit Discard to bail. The agent can also emit `navigate`
  mutations to switch tabs / open projects / focus features in
  response to voice commands like "let's work on icarus" or
  "open the tasks tab" — ambiguous targets fall through to the
  existing Questions flow. "  Open task X" pings the matching
  Kanban card with a transient cyan glow (auto-clears in ~5s)
  rather than hijacking selection state. Custom council lenses
  get their `Persona.accent` painted on each verdict card so
  marketing/security/etc. read visually distinct even when their
  verdicts agree. Assistant replies are spoken back through TTS
  only when the user's last input was voice (typed conversations
  stay silent), and **long replies are summarized to ~3
  sentences before being read aloud** — chat still shows the
  full response. **Open questions can be answered by voice too**:
  each question card has a SPEAK & ANSWER button that reads the
  question aloud and locks the next voice utterance to fire
  `answer_question` instead of going to chat — useful when the
  queue worker enqueues a clarifying question and you want to
  Jarvis your way through it without typing. All voice traffic
  is proxied through icarus-server's `/v1/voice/*` endpoints —
  clients never see the LAN IP.
- **Cursor usage panel** — small pill at the bottom of the
  sidebar shows current billing-cycle spend, percent used, and
  days remaining in the cycle, polling Cursor's undocumented
  dashboard service via the JWT stored in the desktop app's
  `state.vscdb`. Bonus credits surface as a separate "+$N
  bonus" line. Click to force-refresh; click in the
  unavailable state to open `cursor.com/dashboard`. Token is
  read read-only — we never write back to the desktop's auth
  store, so refreshing in icarus can't corrupt your Cursor
  sign-in.
- **Council as system decider** — the council is no longer a
  juried debate the human watches; it's the system's
  decision-maker. After every council run, the chair's verdict
  drives an auto-decide hook: `approve` / `approve_with_notes`
  fires the corresponding `approve_*` mutation automatically;
  `request_changes` leaves the gate closed. Three gates wired:
  flow_review → `approve_flow`, task_planning → `approve_tasks`
  (all proposals at once, not one-by-one), and the new
  **architecture_review** with five hardcoded lenses
  (reliability, scalability, security, cost, operability) →
  `approve_architecture`. Agent emits `request_arch_review` to
  trigger; user can still manually `unapprove_*` to override
  any council decision after the fact. The system prompt + coach
  no longer say "click Approve on the X tab" — the agent now
  routes everything through `request_*_review` and lets the
  council decide.
- **Coach hints** — every chat turn (global and per-project) now
  carries a small `[icarus coach]` directive block computed from
  the live world state, telling the agent the *next focused
  question to ask*. Empty global → "what do you want to build?";
  has projects → "pick up an existing one or start fresh?"; empty
  project → "what's the first feature?"; draft + no flow → "walk
  me through the user journey"; flow_approved + arch empty →
  "what services does this need?"; flow + arch approved → "want me
  to plan the tasks?"; planned → "want me to start the queue?".
  Built around two guardrails: **one focused question per turn,
  not a barrage**, and **follow the user's lead** — the hint is
  guidance, not a script. User-owned verbs (`approve_flow`,
  `approve_architecture`, `approve_tasks`) are still proposed
  conversationally and never emitted by the agent.
- **Persistent chats** — every conversation lives on disk under
  `store/chats/` (global) or `store/<slug>/chats/` (per-project) and
  can be reopened from the sidebar.

## Prerequisites

- A **Cursor API key** — generate one at
  <https://cursor.com/dashboard/integrations>. The dockerized server
  installs `cursor-agent` inside its image and authenticates with this
  key.
- **Docker + Docker Compose** (recommended), **or** Node.js 20+ and the
  `cursor-agent` CLI installed locally if you'd rather run native.

## Run with Docker

```bash
cp .env.example .env
# Edit .env and set CURSOR_API_KEY=crsr_...
# (and optionally WORKSPACE_DIR, voice URLs, etc.)

docker compose up --build
```

Open <http://localhost:8081>. Sign in with the bootstrap admin —
**`admin` / `changeme`** — and you'll be prompted to choose a real
password before the rest of the UI unlocks. See
[`docs/AUTH.md`](./docs/AUTH.md) for the full auth contract (JWT
shape, password reset, secret rotation).

**What the agent can see:** by default `WORKSPACE_DIR` is `./.workspace`
(an empty placeholder dir in the repo) so Docker doesn't trigger macOS
TCC prompts for Documents/Desktop. Set `WORKSPACE_DIR` in `.env` to
whatever folder of code you want the agent rooted at. File writes are
gated behind `CURSOR_ALLOW_FILE_WRITES=true` (passes `--force` to
`cursor-agent`); without it the agent proposes changes but won't apply
them.

Per-project workspaces live under `WORKSPACE_DIR/<slug>` when you
create a project with `workspace_path: "auto"`, or wherever you point
them with an absolute path. A planning-only project (no
`workspace_path`) can be promoted later from the **Code** tab's inline
setup form, which emits `update_project { workspace_path }`.

## Run without Docker

```bash
# Terminal 1 — server
cd server
npm install
npm run dev

# Terminal 2 — app
cd app
npm install
export EXPO_PUBLIC_API_URL=http://localhost:4000
npm run web        # or `npm run ios` / `npm run android`
```

The server uses whichever `cursor-agent` is on your `PATH` and reads
`CURSOR_API_KEY` from the environment (or from a `.env` next to
`docker-compose.yml`, picked up by the
[`./scripts/dev-native.sh`](./server/scripts/dev-native.sh)
launcher).

## Configuration

| Var                              | Default                          | Purpose                                                                                            |
| -------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------- |
| `CURSOR_BIN`                     | `cursor-agent`                   | Path to the CLI. Override if it's installed somewhere unusual.                                     |
| `CURSOR_CWD`                     | `process.cwd()` / `/workspace`   | Working dir the agent operates in (`--workspace`).                                                 |
| `CURSOR_MODEL`                   | _(unset)_                        | Optional model id (`composer-2`, `auto`, …). Empty = CLI default. **Per-role override** in Settings tab → models (chat vs agent). |
| `CURSOR_ALLOW_FILE_WRITES`       | `false`                          | When `true`, passes `--force` so tool calls can mutate files.                                      |
| `CURSOR_DESKTOP_HOST_DIR` (compose) | `~/Library/Application Support/Cursor` (macOS) | Host dir for the Cursor desktop's `state.vscdb` (read-only mount). Powers the Usage pill. Override on Linux (`~/.config/Cursor`) / Windows (`%APPDATA%\Cursor`). |
| `WORKSPACE_DIR` (compose)        | `./.workspace` (empty)           | Host directory bind-mounted at `/workspace`. Per-project workspaces are children of this.          |
| `ICARUS_DATA` (compose)          | `./store`                        | Where the JSON store lives — projects, chats, council runs, activity logs.                         |
| `ICARUS_QUEUE_PARALLELISM`       | `2` (cap `8`)                    | Number of concurrent task slots in the autonomous worker.                                          |
| `PORT`                           | `4000`                           | Server HTTP port.                                                                                  |
| `EXPO_PUBLIC_API_URL`            | `http://localhost:4000`          | API URL the client calls.                                                                          |
| `VOICE_STT_URL`                  | _(unset)_                        | Speech-to-text endpoint. Unset → mic button hidden, voice routes return 503. **Runtime override** in Settings tab; see [`docs/VOICE.md`](./docs/VOICE.md). |
| `VOICE_TTS_URL`                  | _(unset)_                        | Text-to-speech endpoint. Same gating + runtime override as STT.                                    |
| `VOICE_TTS_VOICE`                | `default`                        | Voice id to ask the TTS service for.                                                               |
| `VOICE_TTS_LANGUAGE`             | `en`                             | Language tag for TTS synthesis.                                                                    |
| `JWT_SECRET`                     | _(auto-generated)_               | JWT signing key. Auto-written to `<dataRoot>/.jwt-secret` on first boot; set explicitly to manage rotation. ≥ 16 chars when set. |
| `JWT_EXPIRES_IN`                 | `7d`                             | Token lifetime (`15m` / `24h` / `7d` / seconds — anything `jsonwebtoken` accepts).                 |
| `AUTH_DB_PATH`                   | `<dataRoot>/auth.sqlite`         | SQLite file backing the users table (managed via `aerekos-record`).                                |
| `AUTH_BOOTSTRAP_USERNAME`        | `admin`                          | Bootstrap admin username. Only used when the users table is empty.                                 |
| `AUTH_BOOTSTRAP_PASSWORD`        | `changeme`                       | Bootstrap admin password. Forces a password change on first sign-in.                               |

## Storage layout

State lives on disk under `${ICARUS_DATA:-./store}/`:

```
store/
  auth.sqlite                      # users table (Phase 22 — JWT auth, aerekos-record + sqlite3)
  .jwt-secret                      # auto-generated JWT signing key (gitignored; rotate by deleting)
  fleet.json                       # project index
  tools.json                       # global Tool registry (Phase 10)
  cron.json                        # global Cron registry (Phase 11)
  rules.json                       # global Rules registry (Phase 12)
  tool_proposals.json              # pending agent-emitted tool suggestions (Phase 13)
  personas.json                    # global council personas (Phase 14)
  settings.json                    # global runtime settings — voice toggle (Phase 19), voice endpoint hot-swap (Phase 21), per-role model selection (Phase 20).
  chats/                           # global chats
  <slug>/
    project.json                   # name, description, workspace_path, status
    features.json                  # { features: [...] }
    flows.json                     # per-feature node/edge graphs
    tasks.json                     # { tasks: [...], may carry tool_id + tool_args }
    architecture.json              # services + edges + approved_at
    questions.json                 # open / answered questions inbox
    rules.json                     # project-scoped Rules (Phase 12)
    personas.json                  # project-scoped council personas (Phase 14)
    council/<feature_id>/*.json    # per-run council artifacts
    council.jsonl                  # append-only run summaries
    activity.jsonl                 # append-only mutation log
    chats/                         # per-project chats
```

No DB. Mutations go through a single envelope endpoint
(`POST /v1/mutations/apply`) with Zod-validated, kind-tagged payloads.

## API (smoke tests)

> Every route below requires `Authorization: Bearer <jwt>` (the `/health`
> and `/v1/auth/login` endpoints are the only public ones). See
> [`docs/AUTH.md`](./docs/AUTH.md) for the full contract.

```bash
# Sign in (default bootstrap creds the very first boot — change them).
curl -sS -X POST http://localhost:4000/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"changeme"}' \
  | jq -r .token > /tmp/icarus.jwt
TOKEN="$(cat /tmp/icarus.jwt)"

# Then call any route with the bearer token.
curl -sS -H "Authorization: Bearer $TOKEN" http://localhost:4000/projects | jq
```

- `POST /v1/auth/login` — `{ username, password }` → `{ token, user }`.
- `GET /v1/auth/me` — current user.
- `POST /v1/auth/change-password` — `{ current_password, new_password }`
  → fresh `{ token, user }` (drops `must_change_password`).
- `POST /v1/auth/logout` — stateless echo (clear the token client-side).
- `GET /health` — CLI version + login state (public).
- `GET /projects` — list projects.
- `GET /projects/:slug` — project detail (counts, etc.).
- `GET /projects/:slug/architecture` — `{ architecture: {...} }`.
- `GET /tools` — global tool registry (filter `?include_archived=1`).
- `GET /tools/:ref` — single tool. `ref` accepts the tool's slug or id.
- `GET /cron` — scheduled jobs.
- `GET /rules` — global rules (filter `?include_archived=1`).
- `GET /projects/:slug/rules` — project-scoped rules.
- `GET /tool_proposals` — pending agent-emitted tool suggestions
  (filter `?include_all=1` for the full audit trail including
  accepted + rejected).
- `GET /personas` — global council personas (filter
  `?include_archived=1`).
- `GET /projects/:slug/personas` — project-scoped council personas.
- `GET /personas/resolved` — resolved lens panel for the global
  scope (defaults + global overrides), with provenance per slot.
- `GET /projects/:slug/personas/resolved` — resolved lens panel
  for that project (defaults + global + project), in council
  execution order.
- `POST /v1/mutations/apply` — single applicator endpoint, body
  `{ kind, payload }`. See `plan.md` for the verb table.

### Voice (Phase 15 / 21)

Push-to-talk + hear-it-back. icarus-server proxies a pair of
**hot-swappable** STT and TTS upstreams. The reference stack is
self-hosted Whisper (CTranslate2 + faster-whisper) and XTTS-v2 on
a local LAN box (a Jetson Orin works great), but any service
that speaks the **icarus voice contract** ([`docs/VOICE.md`](./docs/VOICE.md))
plugs in by URL — third-party (OpenAI, ElevenLabs) via a thin
proxy, custom self-hosted, anything.

Three ways to configure (resolved in this order: settings.json
override → env var → built-in default):

1. **`.env` baseline** — set `VOICE_STT_URL`, `VOICE_TTS_URL`
   for the first-install / 12-factor path.
2. **Settings tab → Voice APIs (Phase 21)** — runtime overrides
   for URLs, optional Bearer auth, voice catalog name, language.
   Saving re-probes health within ~1s, no restart.
3. **Chat / agent verbs** — say "use openai whisper" or "switch
   to my orin" and the agent emits `set_voice_endpoints`. Auth
   tokens stay UI-only.

**Off-LAN?** Toggle voice off via the sidebar pill (or say
"voice off" in chat). With the toggle off, the health probe
short-circuits in ~40ms instead of timing out at ~8s, and the
voice POST endpoints fast-fail with HTTP 503 — saving you
from a glitchy UX on the road. Toggle back on when you're
home.

The voice contract is small (`GET /health`, `POST /transcribe`,
`POST /synthesize`); see [`docs/VOICE.md`](./docs/VOICE.md) for
the field-level spec, worked examples wrapping OpenAI Whisper /
ElevenLabs, and a troubleshooting table.

**Off-LAN?** Toggle voice off via the sidebar pill (or say
"voice off" in chat). With the toggle off, the health probe
short-circuits in ~40ms instead of timing out at ~8s, and the
voice POST endpoints fast-fail with HTTP 503 — saving you
from a glitchy UX on the road. Toggle back on when you're
home.

- `GET /v1/voice/health` — combined `{ available, stt, tts,
  disabled_by_user? }` view. Client polls once at startup; the
  mic button hides when `available` is false. When the user has
  flipped the global toggle off (Phase 19) the response
  short-circuits with `disabled_by_user: true` and skips probing
  the upstream entirely (~40ms vs ~8s when off-LAN).
- `GET /v1/settings/voice` (Phase 19 / 21) — `{ disabled, stt, tts }`
  envelope for the current toggle + endpoint config. Includes
  source provenance (`"settings"` / `"env"` / `"unset"`) per
  upstream and the resolved `effective_*` values so the UI can
  show what's actually live. Auth tokens come back masked as
  `"***"` when set.
- `PATCH /v1/settings/voice` (Phase 21) — write voice endpoint
  config. Each field independent: omit to leave alone, send `""`
  to clear (env-var fallback wins), send `"***"` to leave an
  existing auth token untouched. Auth tokens are deliberately
  out of the chat pipeline — humans-only via this endpoint or
  the Settings UI.
- `set_voice_enabled` mutation — flips the global toggle
  (Phase 19). Persists in `store/settings.json` and broadcasts
  `voice_settings_changed`.
- `set_voice_endpoints` mutation (Phase 21) — `{ stt_url?,
  tts_url?, voice?, language? }`. Lets the agent hot-swap voice
  upstreams from chat. Auth tokens are intentionally **not**
  in this verb's payload.
- `POST /v1/voice/transcribe` — body is the raw audio bytes
  (`Content-Type: application/octet-stream`); pass the original
  audio mime via `X-Audio-Content-Type` and an optional original
  filename via `X-Audio-Filename`. Optional query params
  `?language=en` and `?task=transcribe|translate`. Returns
  `{ text, language, duration }`.
- `POST /v1/voice/synthesize` — body `{ text, voice?, language?,
  speed? }`; returns `audio/wav` (24kHz PCM16). Voice and
  language fall back to the env defaults.
- `POST /v1/voice/split_sentences` — pure helper that strips
  markdown/URLs and breaks text into utterance-sized chunks.
  Used by the client's incremental TTS playback.
- `POST /v1/voice/spoken_for_text` (Phase 15.1) — body
  `{ text }`; returns `{ spoken_text, source, original_chars }`.
  `source` is one of `passthrough` (short reply, used as-is),
  `summary` (cursor-agent boiled it down to ≤3 sentences),
  `truncate` (deterministic fallback on summary failure), or
  `empty`. Called once per voice-triggered turn after the
  assistant stream finishes. Trades a few seconds of pre-audio
  silence for not subjecting the listener to multi-paragraph
  essays. Chat display is unaffected — full reply is still
  persisted and rendered.

The agent has a `navigate` verb that doesn't mutate disk
state — it broadcasts a WS `nav_request` event with the
originating client's id. Each kind accepts either an exact id
(`project_slug`, `feature_id`, `task_id`) OR a name
(`project_name`, `feature_name`, `task_name`); the name form
is the escape hatch for **same-turn create + navigate**, since
new ids aren't echoed back to the agent's stream until the
next turn (Phase 21).

```json
{"kind":"navigate","payload":{"target":{"kind":"project","project_slug":"icarus-d8bf","tab":"tasks"},"reason":"matched 'icarus'"}}
{"kind":"navigate","payload":{"target":{"kind":"global","tab":"tools"}}}
{"kind":"navigate","payload":{"target":{"kind":"project","project_name":"Foo"}}}        // resolved server-side after create_project { name:"Foo" }
{"kind":"navigate","payload":{"target":{"kind":"feature","project_slug":"foo-d8bf","feature_name":"Onboarding"}}}
```

Client-side (Phase 21 follow-up): when `selectProject` /
`refreshChats` lands on a scope with no chats yet (e.g. a project
that was just created), icarus auto-creates a fresh chat so the
composer is never stuck in the perma-disabled state.

> **Heads up — Docker Desktop on macOS LAN access.** The
> dockerized server cannot reach LAN peers other than the host
> (e.g. a Jetson on your home subnet running the voice
> services). Docker Desktop's "Enable host networking" beta
> toggle does **not** fix this on macOS — it only puts the
> container in the *Linux VM's* network namespace, which is
> itself NAT'd behind gvisor / vpnkit and firewalled away from
> the Mac's physical LAN subnet. The container can hit the
> open internet but not LAN peers. (Linux hosts don't have
> this problem; Docker on Linux shares the host's network
> namespace directly so the dockerized server can reach the
> LAN normally.)
>
> The working pattern is to run icarus-server natively on
> the Mac (`cd server && ./scripts/dev-native.sh`). The
> launcher loads `../.env`, fills in native-only path
> defaults (`WORKSPACE_ROOT`, `ICARUS_DATA`,
> `CURSOR_DESKTOP_PATH`), and invokes `npm run dev`. The
> dockerized `app` container's browser bundle already
> targets `http://localhost:4000`, so nothing else changes
> when you swap the server from container → native.
>
> `docker compose stop server` first to free port 4000, or
> just don't start `server` in compose at all on macOS.
> The voice routes degrade cleanly — if the upstream is
> unreachable they return `502` and the mic button hides.

### Tools-as-API

Each active tool is callable directly. `:ref` accepts the slug
(preferred — stable, predictable) or the id.

- `POST /v1/tools/:ref/run` — invoke. Body:
  `{ project_slug, args?, title?, priority?, wait?, timeout_ms? }`.
  Default async, returns `202` with `{ run: { run_id, … } }`. With
  `wait=true` blocks until the underlying task finishes (or
  `timeout_ms` elapses, default 5 min, max 30 min) and returns the
  structured `result.summary` / `result.artifacts`.
- `GET /v1/tool_runs/:run_id` — poll a run. `run_id` == task id.
- `GET /v1/tools/:ref/runs` — list past runs of a tool. Filter with
  `?project_slug=…` or `?limit=N` (default 20, max 100).

```bash
# Async — returns immediately with a run_id
curl -sS -X POST -H 'Content-Type: application/json' \
  -d '{"project_slug":"my-proj","args":{"message":"hello"}}' \
  http://localhost:4000/v1/tools/echo-test/run

# Sync — blocks until the agent emits complete_task
curl -sS -X POST -H 'Content-Type: application/json' \
  -d '{"project_slug":"my-proj","args":{"message":"hi"},"wait":true}' \
  http://localhost:4000/v1/tools/echo-test/run

# Poll
curl -sS http://localhost:4000/v1/tool_runs/task_abc123
```

Internal-only — no auth, intended for chat / cron / scripts on the
same host. Tools execute through the existing queue worker, so
parallelism, retries, and lifecycle events are unchanged.

### Rules

Free-form `AGENTS.md`-style guidance prepended to every cursor-agent
prompt — chat, queue worker, council lenses + chair, tool runs.

Two scopes:
- **Global** (`store/rules.json`) — applied across every project.
- **Project** (`store/<slug>/rules.json`) — applied only when the
  current scope is that project. Stacks on top of globals.

Mutation verbs (envelope `kind`):
- `create_rule` — `{ scope: { kind: "global" } | { kind: "project",
  project_slug }, title, body, category?, enabled? }`.
- `update_rule` — `{ rule_id, scope?, title?, body?, category?,
  enabled? }`.
- `archive_rule` — `{ rule_id, scope? }` (soft delete).
- `set_rule_enabled` — `{ rule_id, enabled, scope? }` (mute without
  deleting).

The `scope?` is a fast path; when omitted the applicator scans global
+ every project to locate the id.

Bodies are markdown, capped at 8 KB by Zod and at 1.5 KB *per rule*
when injected into a prompt. Disabled and archived rules are skipped
at injection.

```bash
# Add a global rule
curl -sS -X POST -H 'Content-Type: application/json' \
  -d '{
    "kind":"create_rule",
    "payload":{
      "scope":{"kind":"global"},
      "title":"Always run typecheck before claiming done",
      "body":"Before emitting `complete_task`, run `npm run -s typecheck` (or the project equivalent) and quote the exit code in your summary."
    }
  }' \
  http://localhost:4000/v1/mutations/apply

# Add a project rule
curl -sS -X POST -H 'Content-Type: application/json' \
  -d '{
    "kind":"create_rule",
    "payload":{
      "scope":{"kind":"project","project_slug":"my-proj"},
      "title":"Use pnpm",
      "body":"This project pins pnpm — never run `npm install`. Use `pnpm install` / `pnpm add`."
    }
  }' \
  http://localhost:4000/v1/mutations/apply

# List
curl -sS http://localhost:4000/rules
curl -sS http://localhost:4000/projects/my-proj/rules
```

### Tool suggestions

The agent flags repeatable work mid-turn by emitting `propose_tool`,
which lands as a pending `ToolProposal`. The user reviews and
accepts (with optional overrides) to materialize a real Tool, or
rejects to soft-delete.

Mutation verbs (envelope `kind`):
- `propose_tool` — `{ name, description?, category?, prompt_template,
  params?, rationale?, source: { kind: "chat"|"task"|"tool_run",
  project_slug?, chat_id?, message_id?, task_id? } }`. Non-terminal,
  the agent emits it alongside its normal terminal verb.
- `accept_tool_proposal` — `{ proposal_id, overrides?: { name?, slug?,
  description?, category?, prompt_template?, params? } }`. Reuses
  `applyCreateTool` internally; stamps `tool_id` on the proposal and
  flips status to `accepted`.
- `reject_tool_proposal` — `{ proposal_id }` (soft delete; idempotent
  for already-rejected, 409 for accepted).

```bash
# List pending suggestions (default)
curl -sS http://localhost:4000/tool_proposals

# Full audit trail (pending + accepted + rejected)
curl -sS 'http://localhost:4000/tool_proposals?include_all=1'

# Manually accept a proposal with a slug override
curl -sS -X POST -H 'Content-Type: application/json' \
  -d '{
    "kind":"accept_tool_proposal",
    "payload":{
      "proposal_id":"tprop_aa62de54492f",
      "overrides":{"slug":"pytest-coverage-report"}
    }
  }' \
  http://localhost:4000/v1/mutations/apply
```

### Council personas

The flow-review council ships with five default lenses (`product`,
`ux`, `architecture`, `security`, `operability`). Add a `Persona`
with the same `key` to **replace** that lens; pick any other `key`
(e.g. `marketing`, `legal`) to **add** a new lens. Globals apply
to every project; project personas override globals on the same
key, or add new lenses just for that project.

Mutation verbs (envelope `kind`):
- `create_persona` — `{ scope, key, name, description?,
  prompt_template, accent? }` where `scope` is
  `{ kind: "global" } | { kind: "project", project_slug }`.
- `update_persona` — `{ persona_id, scope?, key?, name?,
  description?, prompt_template?, accent? }`. Scope is optional;
  the applicator falls back to id-scan across the fleet.
- `archive_persona` — `{ persona_id, scope? }` (soft-delete).

```bash
# Replace the default UX lens, fleet-wide, with a mobile-first charter
curl -sS -X POST -H 'Content-Type: application/json' \
  -d '{
    "kind":"create_persona",
    "payload":{
      "scope":{"kind":"global"},
      "key":"ux",
      "name":"UX (Mobile-first)",
      "prompt_template":"Walk every step on a 5-inch screen with thumb-only input on flaky 3G..."
    }
  }' \
  http://localhost:4000/v1/mutations/apply

# Add a marketing lens just for this project
curl -sS -X POST -H 'Content-Type: application/json' \
  -d '{
    "kind":"create_persona",
    "payload":{
      "scope":{"kind":"project","project_slug":"my-proj"},
      "key":"marketing",
      "name":"Marketing",
      "prompt_template":"Is the value prop crisp in step one? Where is the activation moment?"
    }
  }' \
  http://localhost:4000/v1/mutations/apply

# Inspect what the council will actually run for this project
curl -sS http://localhost:4000/projects/my-proj/personas/resolved
```

The full surface area (chats, files, council runs, queue snapshot, WS
events) is documented in [`plan.md`](./plan.md).

## License

[MIT](./LICENSE).

icarus uses the proprietary [Cursor](https://cursor.com) `cursor-agent`
CLI as its inference backend. You bring your own Cursor account and API
key; nothing in this repo provides or substitutes for that.
