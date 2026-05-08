import type { Rule } from "../domain.js";
import { readEffectiveRules } from "../storage/rules.js";

/**
 * Phase 12 — rule injection.
 *
 * Every place we spawn a `cursor-agent` run prepends the rules block
 * returned here to the prompt: chat turns, queue/task worker, council
 * lenses + chair, tool runs (the queue worker handles those too).
 *
 * Design choices:
 *   - Rules are *prepended* rather than woven into individual prompt
 *     builders. This keeps the existing prompt builders unaware of
 *     rules — adding a new caller is a one-liner.
 *   - Global rules come first, then project rules. Bodies preserve
 *     authoring order (oldest → newest by `created_at`); the storage
 *     layer sorts.
 *   - Each rule body is hard-capped to keep token budgets in check —
 *     defensive, matches the schema's 8 KB body cap with a typically
 *     1.5 KB injected slice. Truncation appends "…(truncated)".
 *   - Disabled / archived rules are filtered out by the storage
 *     helper, so the inject path never sees them.
 *   - When there are no rules to inject, returns an empty string —
 *     callsites just concatenate.
 */

const MAX_BODY_CHARS_PER_RULE = 1500;
const HARD_BLOCK_CHAR_BUDGET = 12_000;

export type InjectionScope =
  | { kind: "global" }
  | { kind: "project"; slug: string };

/**
 * Build the rules block for the given scope. Returns `""` when there's
 * nothing to inject (no enabled active rules), so the prompt stays
 * unchanged. Otherwise returns a self-contained markdown-ish block
 * with a leading + trailing newline so callers can simply prepend it
 * to their existing prompt string.
 */
export async function formatRulesBlock(scope: InjectionScope): Promise<string> {
  const projectSlug = scope.kind === "project" ? scope.slug : undefined;
  const { global, project } = await readEffectiveRules(projectSlug);
  if (global.length === 0 && project.length === 0) return "";

  const lines: string[] = [];
  lines.push("[icarus rules — apply throughout this run]");
  if (global.length > 0) {
    lines.push("", "## Global rules");
    for (const r of global) lines.push("", ...formatOneRule(r));
  }
  if (project.length > 0) {
    lines.push("", `## Project rules (${scope.kind === "project" ? scope.slug : ""})`);
    for (const r of project) lines.push("", ...formatOneRule(r));
  }
  lines.push("", "[end icarus rules]", "");

  let block = lines.join("\n");
  if (block.length > HARD_BLOCK_CHAR_BUDGET) {
    block = `${block.slice(0, HARD_BLOCK_CHAR_BUDGET)}\n…(rules block truncated to fit)\n[end icarus rules]\n`;
  }
  return `${block}\n`;
}

function formatOneRule(rule: Rule): string[] {
  const bodyLines: string[] = [];
  bodyLines.push(`### ${rule.title}${rule.category ? `  _(${rule.category})_` : ""}`);
  let body = rule.body.trim();
  if (body.length > MAX_BODY_CHARS_PER_RULE) {
    body = `${body.slice(0, MAX_BODY_CHARS_PER_RULE)}…(truncated)`;
  }
  bodyLines.push(body);
  return bodyLines;
}
