import type { Rule } from "../domain.js";
import { readGlobalRules, writeGlobalRules } from "../storage/rules.js";

/**
 * Default global rules seeded on first boot.
 *
 * Identified by stable `id`s (`default_*`) so we can detect "already
 * seeded" without a separate marker file. The check is per-id, so
 * future edits to the bootstrap set add new defaults without
 * disturbing rules the user has accepted, edited, or deleted.
 *
 * Once a default has been seeded, the user fully owns it: they can
 * archive, disable, or rewrite it from the Rules tab and the
 * bootstrap will not re-add or "fix" it on subsequent boots. The
 * `id` collision is what makes the seed idempotent.
 *
 * If a user actively *removes* a default (hard delete), it stays
 * removed — no resurrection. To re-seed deliberately, run the agent
 * via `create_rule` from chat, or restore the file from a backup.
 */

/** Per-rule body cap matches the schema's 8 KB ceiling. Kept comfortably under. */
const DEFAULT_RULES: ReadonlyArray<Pick<Rule, "id" | "title" | "category" | "body">> = [
  {
    id: "default_stack_choices",
    title: "Default stack: Docker + React + Node.js + aerekos-record",
    category: "stack",
    body: [
      "When the user asks you to scaffold or extend a project without specifying",
      "the stack, default to:",
      "",
      "- **Containerization:** Dockerize everything. Each service ships a",
      "  `Dockerfile`; multi-service apps get a top-level `docker-compose.yml`.",
      "  Even small one-shot scripts get a Dockerfile so they're reproducible.",
      "  Bind-mount source for dev, copy in for prod. Use slim Node base images",
      "  (`node:20-bookworm-slim` is a safe default).",
      "",
      "- **Frontend:** React. Prefer Expo + React Native Web when the user wants",
      "  a mobile-and-web shell from one codebase (matches icarus itself);",
      "  Vite + React when they explicitly want web-only. Either way, ship it",
      "  in its own container behind a dev server (`expo start --web` /",
      "  `vite dev`) for development and a built static bundle for prod.",
      "",
      "- **Backend:** Node.js (Express or Fastify, picker's choice — Express",
      "  unless the user has a reason). Use",
      "  [`aerekos-record`](https://www.npmjs.com/package/aerekos-record) for",
      "  any persistence layer; pick the SQLite adapter by default",
      "  (`Record.connect('sqlite', { database: ... })`). Aerekos-record's",
      "  unified `model()` API plays nicely with Postgres / MySQL / Mongo / etc.",
      "  later if the project outgrows SQLite — no rewrite, just a different",
      "  `connect()` call.",
      "",
      "Pick TypeScript for both frontend and backend unless the user opts out.",
      "These are defaults, not laws — if the user asks for something else",
      "(Python, Go, Rust, no Docker, …) follow them, but call out that they're",
      "stepping off the beaten path so the choice is intentional.",
    ].join("\n"),
  },
  {
    id: "default_runtime_environment",
    title: "Runtime environment: you're inside a Docker container",
    category: "runtime",
    body: [
      "You — the cursor-agent process running this chat — execute inside a",
      "Docker container (`icarus-server`). When you reason about file paths,",
      "binaries, or network reachability, remember:",
      "",
      "- The host's filesystem is **not** your filesystem. You see only what's",
      "  bind-mounted (typically `/workspace`, `/app`, and `/var/run/docker.sock`).",
      "  When the user asks you to read or modify code, do it via paths under",
      "  the project workspace, not by guessing at host paths.",
      "",
      "- You **can launch sibling containers**. The host's Docker socket is",
      "  bind-mounted at `/var/run/docker.sock`, and `docker` + `docker compose`",
      "  CLIs are installed in your image. So `docker run`, `docker compose up`,",
      "  `docker exec`, and friends all work — they just talk to the host's",
      "  Docker daemon, NOT some daemon-in-a-daemon. Containers you start are",
      "  siblings of `icarus-server`, not children.",
      "",
      "- Sibling containers can reach each other on the same Docker network",
      "  (`icarus_default` by default in this repo). Use service names as",
      "  hostnames (`http://server:4000`, etc.) when you wire them up.",
      "",
      "- The host's localhost is reachable as `host.docker.internal` on Docker",
      "  Desktop (macOS/Windows). On Linux pass `--add-host=host.docker.internal:host-gateway`",
      "  if the user needs it.",
      "",
      "- LAN peers (e.g. a Jetson on the same Wi-Fi) are NOT reachable from",
      "  Docker Desktop on macOS — that's a known platform limitation. icarus",
      "  itself works around this by running the server natively on Mac for",
      "  voice features. If a feature needs LAN access on macOS, surface that",
      "  caveat to the user instead of silently failing.",
      "",
      "When you scaffold infra that should run BESIDE icarus, prefer adding a",
      "service to the project's own `docker-compose.yml` rather than telling",
      "the user to install something on the host. Containers all the way down.",
    ].join("\n"),
  },
];

/**
 * Seed the default global rules on first boot. Idempotent at the rule
 * level — a rule whose `id` already exists is left untouched, so users
 * can edit the seeded defaults and their changes survive every restart.
 */
export async function ensureBootstrapRules(): Promise<void> {
  const existing = await readGlobalRules();
  const existingIds = new Set(existing.map((r) => r.id));
  const now = Date.now();

  const additions: Rule[] = [];
  for (const def of DEFAULT_RULES) {
    if (existingIds.has(def.id)) continue;
    additions.push({
      id: def.id,
      scope: "global",
      title: def.title,
      body: def.body,
      category: def.category,
      enabled: true,
      status: "active",
      created_at: now,
      updated_at: now,
    });
  }

  if (additions.length === 0) return;

  // Prepend defaults so they show up at the top of the Rules tab on a
  // fresh install. User-authored rules (added later) accumulate below
  // by `created_at`, so the defaults stay grouped together.
  await writeGlobalRules([...additions, ...existing]);
  console.log(
    `[rules] seeded ${additions.length} default global rule(s): ` +
      additions.map((r) => r.id).join(", "),
  );
}
