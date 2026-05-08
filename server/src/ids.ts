import { randomBytes } from "node:crypto";

const SLUG_BASE_MAX = 32;
const SLUG_SUFFIX_LEN = 4;

/**
 * Slugify a name into something filesystem-safe and short, with a short
 * random suffix so collisions are virtually impossible without us having
 * to scan the existing fleet.
 *
 * "My Cool Project" → "my-cool-project-7f3a"
 */
export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, SLUG_BASE_MAX) || "project";
  const suffix = randomBytes(SLUG_SUFFIX_LEN).toString("hex").slice(0, SLUG_SUFFIX_LEN);
  return `${base}-${suffix}`;
}

export function shortId(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString("hex")}`;
}

/**
 * Stable slug derived from a name, with no random suffix. Used for
 * resources where the user *wants* a predictable URL — Tools (Phase 10)
 * use these so the callable HTTP endpoint at
 * `/v1/tools/<slug>/run` stays stable across edits.
 *
 * Caller is responsible for collision handling. We expose
 * `dedupeSlug` for the common "append `-2`, `-3`, …" strategy.
 *
 * "Run Tests" → "run-tests"
 * "  Bump Dep!  " → "bump-dep"
 */
export function nameToSlug(name: string, fallback = "tool"): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 64);
  return base || fallback;
}

/**
 * If `proposed` is already in `taken`, append `-2`, `-3`, … until a free
 * slot is found. Single-process only — caller must serialize against
 * concurrent writes via the relevant lock.
 */
export function dedupeSlug(proposed: string, taken: ReadonlySet<string>): string {
  if (!taken.has(proposed)) return proposed;
  for (let n = 2; n < 1_000; n++) {
    const candidate = `${proposed}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error(`could not dedupe slug ${proposed}: too many collisions`);
}
