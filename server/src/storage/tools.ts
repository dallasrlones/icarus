import type { Tool } from "../domain.js";
import { dedupeSlug, nameToSlug } from "../ids.js";
import { readJsonOr, writeJson } from "./json.js";
import { toolsFile } from "./paths.js";

/**
 * Disk-backed read/write for the global tool registry. Single file at the
 * data root — tools are reusable across projects, so it doesn't fit any
 * per-project folder. We keep the entire registry in one JSON because
 * the working set is tiny (tens at most) and atomic file replacement is
 * easier to reason about than per-tool files.
 *
 * No in-process cache: applicators always read fresh, write atomically,
 * and the global tool-registry mutex serializes writes (see
 * `globalLocks` in storage/locks.ts).
 */

interface ToolsFile {
  tools: Tool[];
}

const EMPTY: ToolsFile = { tools: [] };

/**
 * Read all tools. Backfills `slug` for any pre-Phase-10.1 records that
 * lack one — derived from `name` and deduped against already-assigned
 * slugs in the same file. Read-only callers see consistent slugs even
 * before the next write happens.
 */
export async function readTools(): Promise<Tool[]> {
  const data = await readJsonOr<ToolsFile>(toolsFile(), EMPTY);
  const raw = Array.isArray(data.tools) ? data.tools : [];
  const taken = new Set<string>();
  return raw.map((t) => {
    if (typeof t.slug === "string" && t.slug.length > 0) {
      taken.add(t.slug);
      return t;
    }
    const proposed = nameToSlug(t.name ?? "tool");
    const slug = dedupeSlug(proposed, taken);
    taken.add(slug);
    return { ...t, slug };
  });
}

export async function writeTools(tools: Tool[]): Promise<void> {
  await writeJson(toolsFile(), { tools });
}

/**
 * Resolve a slug-or-id reference to a single tool. Tools are addressable
 * by either their opaque id (`tool_xxxx`) or their stable slug. Slugs
 * win on collision (only active tools, last-created first). Returns
 * `null` if no match — callers translate that to a 404 at the route
 * layer.
 */
export async function findToolByRef(ref: string): Promise<Tool | null> {
  const tools = await readTools();
  const byId = tools.find((t) => t.id === ref);
  if (byId) return byId;
  const bySlug = tools
    .filter((t) => t.slug === ref && t.status === "active")
    .sort((a, b) => b.created_at - a.created_at);
  return bySlug[0] ?? null;
}
