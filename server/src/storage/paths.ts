import path from "node:path";

const DEFAULT_ROOT = path.resolve(process.cwd(), "store");

const root = process.env.ICARUS_DATA
  ? path.resolve(process.env.ICARUS_DATA)
  : DEFAULT_ROOT;

export function dataRoot(): string {
  return root;
}

export function fleetFile(): string {
  return path.join(root, "fleet.json");
}

/**
 * Phase 19 — global runtime settings (voice toggle, etc.). Single
 * file at the data root, JSON. Schema versioned by adding fields
 * with sensible defaults — `readSettings` always shapes a complete
 * object so callers don't have to handle partial migrations.
 */
export function settingsFile(): string {
  return path.join(root, "settings.json");
}

export function globalChatsDir(): string {
  return path.join(root, "chats");
}

export function globalChatsIndex(): string {
  return path.join(globalChatsDir(), "index.json");
}

export function globalChatFile(id: string): string {
  return path.join(globalChatsDir(), `${id}.json`);
}

export function projectDir(slug: string): string {
  return path.join(root, slug);
}

export function projectFile(slug: string, name: string): string {
  return path.join(projectDir(slug), name);
}

export function projectChatsDir(slug: string): string {
  return path.join(projectDir(slug), "chats");
}

export function projectChatsIndex(slug: string): string {
  return path.join(projectChatsDir(slug), "index.json");
}

export function projectChatFile(slug: string, id: string): string {
  return path.join(projectChatsDir(slug), `${id}.json`);
}

export function activityFile(slug: string): string {
  return path.join(projectDir(slug), "activity.jsonl");
}

export function globalActivityFile(): string {
  return path.join(root, "activity.jsonl");
}

export function councilDir(slug: string, featureId: string): string {
  return path.join(projectDir(slug), "council", featureId);
}

export function councilRunFile(
  slug: string,
  featureId: string,
  runType: string,
  runId: string,
): string {
  return path.join(councilDir(slug, featureId), `${runType}-${runId}.json`);
}

export function questionsFile(slug: string): string {
  return path.join(projectDir(slug), "questions.json");
}

export function taskRunsDir(slug: string): string {
  return path.join(projectDir(slug), "task_runs");
}

export function taskRunFile(slug: string, taskId: string, runId: string): string {
  return path.join(taskRunsDir(slug), `${taskId}-${runId}.json`);
}

// ---- Tools / Cron registries (global; Phase 10 / Phase 11) ----

export function toolsFile(): string {
  return path.join(root, "tools.json");
}

export function cronFile(): string {
  return path.join(root, "cron.json");
}

// ---- Cron — standalone target storage (Phase 23) ----
//
// Standalone cron jobs own a workspace (where cursor-agent operates,
// host-side under WORKSPACE_ROOT) and a state directory (where icarus
// keeps the per-run history + transcripts). Two roots so the user can
// separately back up "what the agent produced" vs "icarus's bookkeeping
// about how it got there".

export function cronStateRoot(): string {
  return path.join(root, "_cron");
}

export function cronStateDir(cronSlug: string): string {
  return path.join(cronStateRoot(), cronSlug);
}

export function cronRunsFile(cronSlug: string): string {
  return path.join(cronStateDir(cronSlug), "runs.jsonl");
}

export function cronTranscriptsDir(cronSlug: string): string {
  return path.join(cronStateDir(cronSlug), "transcripts");
}

export function cronTranscriptFile(cronSlug: string, runId: string): string {
  return path.join(cronTranscriptsDir(cronSlug), `${runId}.jsonl`);
}

/**
 * Where the cron's cursor-agent invocation cd's into. Lives under
 * `<WORKSPACE_ROOT>/_cron/<slug>/`. Caller passes `workspaceRoot`
 * because that value comes from the runtime config (env var) rather
 * than the data root used by everything else above.
 */
export function cronWorkspaceDir(workspaceRoot: string, cronSlug: string): string {
  return path.join(workspaceRoot, "_cron", cronSlug);
}

// ---- Tool Proposals (Phase 13) ----

export function toolProposalsFile(): string {
  return path.join(root, "tool_proposals.json");
}

// ---- Personas (Phase 14) ----

export function globalPersonasFile(): string {
  return path.join(root, "personas.json");
}
export function projectPersonasFile(slug: string): string {
  return path.join(projectDir(slug), "personas.json");
}

// ---- Rules (Phase 12) ----
//
// Global rules sit at the data root next to fleet.json so they're easy
// to spot. Per-project rules live in the project directory alongside
// features/flows/tasks — same pattern as questions.json /
// architecture.json.

export function globalRulesFile(): string {
  return path.join(root, "rules.json");
}

export function projectRulesFile(slug: string): string {
  return path.join(projectDir(slug), "rules.json");
}
