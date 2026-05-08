import type { Persona } from "../domain.js";
import { readGlobalPersonas, readProjectPersonas } from "../storage/personas.js";

/**
 * Phase 14 — council persona registry.
 *
 * Bundles two responsibilities into one module so callers don't have
 * to thread "default + global + project" merging through every prompt
 * builder:
 *   1. The five **default** lenses (`product`, `ux`, `architecture`,
 *      `security`, `operability`) live here as the source of truth.
 *      They were previously embedded in `council/prompts.ts`; lifting
 *      them lets custom personas replace them on a per-key basis.
 *   2. `resolveCouncilPersonas(slug?)` returns the ordered list of
 *      lenses that the council should actually run for a given scope,
 *      annotated with provenance for the UI.
 *
 * Resolution rules ("replace_lenses" semantics):
 *   - Walk the default order. For each default key, check global
 *     personas (most-recent active wins) and then project personas
 *     (most-recent active wins). Project beats global beats default.
 *   - After defaults, append global personas with non-default keys
 *     (sorted by created_at), then project personas with non-default
 *     keys (sorted by created_at). Project still beats global on
 *     duplicate non-default keys.
 *
 * The result is a deterministic, ordered list of `ResolvedPersona`
 * shapes — what the runner iterates over instead of the old
 * `LENS_IDS` constant.
 */

export interface DefaultPersona {
  key: string;
  name: string;
  description: string;
  prompt_template: string;
  accent: "cyan" | "violet" | "amber" | "green" | "rose";
}

/**
 * Default lens charters. Order is the canonical council order — UI
 * and prompts render lenses in this sequence, with custom personas
 * appended at the end.
 */
export const DEFAULT_PERSONAS: DefaultPersona[] = [
  {
    key: "product",
    name: "Product",
    accent: "cyan",
    description: "Does this serve a real user need with a measurable outcome?",
    prompt_template:
      "Does this serve a real user need with a clear, measurable outcome? " +
      "Is the scope right (not too small, not too sprawling)? Are success " +
      "metrics implied or specified?",
  },
  {
    key: "ux",
    name: "UX",
    accent: "rose",
    description: "Walk the flow as the user. Crisp happy path? Edges covered?",
    prompt_template:
      "Walk the flow as the user would. Is the happy path crisp? Are error " +
      "and edge paths covered? Are decisions actually decisions (not " +
      "implicit)? Anything that would feel surprising, slow, or " +
      "frustrating?",
  },
  {
    key: "architecture",
    name: "Architecture",
    accent: "violet",
    description: "Does this fit the system? Hidden coupling? State ownership?",
    prompt_template:
      "Does this fit the existing system? Reuse where reasonable? Any " +
      "hidden coupling, race conditions, or migration pain? Is state " +
      "ownership clear? Is the data model coherent?",
  },
  {
    key: "security",
    name: "Security",
    accent: "amber",
    description: "Auth, validation, exposure, secrets, audit, rate limits.",
    prompt_template:
      "Auth, authorization, input validation, data exposure, secrets, PII, " +
      "audit trail, rate limiting, replay/CSRF/XSS for any web touchpoint. " +
      "Call out anything that would need a security review.",
  },
  {
    key: "operability",
    name: "Operability",
    accent: "green",
    description: "Logs, metrics, failure modes, recoverability, runbook.",
    prompt_template:
      "Observability (logs, metrics, traces), failure modes, recoverability, " +
      "deploy/rollback story, runbook implications, dependencies on " +
      "external services. What will hurt at 3 AM if this breaks?",
  },
];

const DEFAULT_KEYS: Set<string> = new Set(DEFAULT_PERSONAS.map((p) => p.key));

export function isDefaultKey(key: string): boolean {
  return DEFAULT_KEYS.has(key);
}

export interface ResolvedPersona {
  key: string;
  name: string;
  description?: string;
  prompt_template: string;
  accent?: DefaultPersona["accent"];
  source: "default" | "global" | "project";
  /** Set when source ≠ "default". */
  persona_id?: string;
}

/**
 * Pick the most-recently-updated active persona for a key, if any.
 * "Most recent active" matches user expectation when they edit a
 * persona to refine its charter — the latest wording wins without
 * having to archive the older one.
 */
function pickActiveByKey(personas: Persona[], key: string): Persona | undefined {
  let best: Persona | undefined;
  for (const p of personas) {
    if (p.status !== "active") continue;
    if (p.key !== key) continue;
    if (!best || p.updated_at > best.updated_at) best = p;
  }
  return best;
}

/** Active personas grouped by key (most-recent active per key). */
function activeByKey(personas: Persona[]): Map<string, Persona> {
  const out = new Map<string, Persona>();
  for (const p of personas) {
    if (p.status !== "active") continue;
    const cur = out.get(p.key);
    if (!cur || p.updated_at > cur.updated_at) out.set(p.key, p);
  }
  return out;
}

function defaultToResolved(d: DefaultPersona): ResolvedPersona {
  return {
    key: d.key,
    name: d.name,
    description: d.description,
    prompt_template: d.prompt_template,
    accent: d.accent,
    source: "default",
  };
}

function personaToResolved(p: Persona, source: "global" | "project"): ResolvedPersona {
  return {
    key: p.key,
    name: p.name,
    description: p.description,
    prompt_template: p.prompt_template,
    accent: p.accent,
    source,
    persona_id: p.id,
  };
}

/**
 * Returns the ordered, fully-resolved list of council lenses for the
 * given scope. Pass `undefined` (or omit) for a global resolution
 * (no project overrides, e.g. the global Personas tab preview).
 *
 * Stable order: defaults first (in canonical order, possibly replaced
 * by globals/projects), then global-only additions, then project-only
 * additions.
 */
export async function resolveCouncilPersonas(
  projectSlug?: string,
): Promise<ResolvedPersona[]> {
  const globals = await readGlobalPersonas();
  const project = projectSlug ? await readProjectPersonas(projectSlug) : [];

  const globalsByKey = activeByKey(globals);
  const projectByKey = activeByKey(project);

  const out: ResolvedPersona[] = [];
  const seen = new Set<string>();

  // 1) Walk default order, replacing per key when a custom persona
  //    matches. Project beats global beats default.
  for (const def of DEFAULT_PERSONAS) {
    const proj = projectByKey.get(def.key);
    const glob = globalsByKey.get(def.key);
    if (proj) out.push(personaToResolved(proj, "project"));
    else if (glob) out.push(personaToResolved(glob, "global"));
    else out.push(defaultToResolved(def));
    seen.add(def.key);
  }

  // 2) Globals with non-default keys, sorted by created_at for stable
  //    UI ordering. Project may still override on the same key —
  //    pickActiveByKey picks the project version below.
  const sortedGlobals = [...globals]
    .filter((g) => g.status === "active" && !DEFAULT_KEYS.has(g.key))
    .sort((a, b) => a.created_at - b.created_at);
  for (const g of sortedGlobals) {
    if (seen.has(g.key)) continue;
    const proj = pickActiveByKey(project, g.key);
    out.push(proj ? personaToResolved(proj, "project") : personaToResolved(g, "global"));
    seen.add(g.key);
  }

  // 3) Project-only additions (keys neither default nor globally
  //    declared), sorted by created_at.
  const sortedProject = [...project]
    .filter((p) => p.status === "active" && !seen.has(p.key))
    .sort((a, b) => a.created_at - b.created_at);
  for (const p of sortedProject) {
    if (seen.has(p.key)) continue;
    out.push(personaToResolved(p, "project"));
    seen.add(p.key);
  }

  return out;
}
