import type { Rule } from "../domain.js";
import { readJsonOr, writeJson } from "./json.js";
import { globalRulesFile, projectRulesFile } from "./paths.js";

/**
 * Disk-backed reads/writes for rules (Phase 12).
 *
 * Rules live in two scopes:
 *   - Global: `store/rules.json`              — apply to every invocation.
 *   - Project: `store/<slug>/rules.json`      — apply only when the
 *     invocation is scoped to that project.
 *
 * Same `{ rules: [...] }` wrapper as the other registries (tools, cron)
 * so future migrations can add file-level metadata without breaking
 * older clients. Volume is tiny — single-user, dozens of rules at most
 * — so we always read/modify/write the whole file under a lock.
 */

interface RulesFile {
  rules: Rule[];
}

/**
 * Always pass a *fresh* fallback to `readJsonOr`. A module-level
 * `const EMPTY = { rules: [] }` would be shared across reads, and our
 * applicators mutate the returned array in place (`.unshift(...)`),
 * which would leak the previous file's rules into a sibling file's
 * supposedly-empty fallback. Bit me once during smoke testing —
 * keeping the literal here so it can't happen again.
 */
function readFromFile(file: string): Promise<RulesFile> {
  return readJsonOr<RulesFile>(file, { rules: [] });
}

/**
 * Read all global rules. Always returns an array — never throws on a
 * missing file. Filtering by `enabled` / `status` is done by callers
 * because the same file feeds both the prompt-injection path (active +
 * enabled) and the UI list (everything, archived included on demand).
 */
export async function readGlobalRules(): Promise<Rule[]> {
  const data = await readFromFile(globalRulesFile());
  return Array.isArray(data.rules) ? data.rules : [];
}

export async function writeGlobalRules(rules: Rule[]): Promise<void> {
  await writeJson(globalRulesFile(), { rules });
}

export async function readProjectRules(slug: string): Promise<Rule[]> {
  const data = await readFromFile(projectRulesFile(slug));
  return Array.isArray(data.rules) ? data.rules : [];
}

export async function writeProjectRules(slug: string, rules: Rule[]): Promise<void> {
  await writeJson(projectRulesFile(slug), { rules });
}

/**
 * Locate a rule by id without a scope hint. Used by mutations like
 * `update_rule` whose payload only carries the rule id — we need to
 * find which file owns it. Walks global first (small, common case),
 * then per-project. Returns `null` if no project owns it.
 *
 * Callers must hold the relevant lock when mutating; this helper is
 * read-only and doesn't lock.
 */
export async function findRuleById(
  ruleId: string,
  projectSlugs: string[],
): Promise<{ rule: Rule; scope: "global" } | { rule: Rule; scope: "project"; project_slug: string } | null> {
  const global = await readGlobalRules();
  const g = global.find((r) => r.id === ruleId);
  if (g) return { rule: g, scope: "global" };
  for (const slug of projectSlugs) {
    const proj = await readProjectRules(slug);
    const p = proj.find((r) => r.id === ruleId);
    if (p) return { rule: p, scope: "project", project_slug: slug };
  }
  return null;
}

/**
 * Convenience: collect every active+enabled rule that should apply to
 * an invocation in the given scope. Global rules always come first in
 * declaration order (oldest → newest by `created_at`); project rules
 * come second when a slug is provided. Archived/disabled rules are
 * filtered out. Used by the prompt-injection helper.
 */
export async function readEffectiveRules(
  projectSlug: string | undefined,
): Promise<{ global: Rule[]; project: Rule[] }> {
  const globals = (await readGlobalRules())
    .filter((r) => r.enabled && r.status === "active")
    .sort((a, b) => a.created_at - b.created_at);
  if (!projectSlug) return { global: globals, project: [] };
  const project = (await readProjectRules(projectSlug))
    .filter((r) => r.enabled && r.status === "active")
    .sort((a, b) => a.created_at - b.created_at);
  return { global: globals, project };
}
