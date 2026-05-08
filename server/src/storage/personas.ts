import type { Persona } from "../domain.js";
import { readJsonOr, writeJson } from "./json.js";
import { globalPersonasFile, projectPersonasFile } from "./paths.js";

/**
 * Phase 14 — disk-backed reads/writes for the council-persona
 * registries.
 *
 * Two scopes mirror the rules layout:
 *   - `store/personas.json`            — global personas
 *   - `store/<slug>/personas.json`     — project-scoped personas
 *
 * Same fresh-fallback pattern as Phase 12/13: pass a NEW `{ personas:
 * [] }` literal on every call so applicators that mutate the array
 * in place don't bleed state across reads.
 */

interface PersonasFile {
  personas: Persona[];
}

function readFromFile(file: string): Promise<PersonasFile> {
  return readJsonOr<PersonasFile>(file, { personas: [] });
}

export async function readGlobalPersonas(): Promise<Persona[]> {
  const data = await readFromFile(globalPersonasFile());
  return Array.isArray(data.personas) ? data.personas : [];
}

export async function writeGlobalPersonas(personas: Persona[]): Promise<void> {
  await writeJson(globalPersonasFile(), { personas });
}

export async function readProjectPersonas(slug: string): Promise<Persona[]> {
  const data = await readFromFile(projectPersonasFile(slug));
  return Array.isArray(data.personas) ? data.personas : [];
}

export async function writeProjectPersonas(slug: string, personas: Persona[]): Promise<void> {
  await writeJson(projectPersonasFile(slug), { personas });
}

export async function findPersonaById(id: string): Promise<{
  persona: Persona;
  scope: "global" | "project";
  project_slug?: string;
} | null> {
  const globals = await readGlobalPersonas();
  const found = globals.find((p) => p.id === id);
  if (found) return { persona: found, scope: "global" };
  // Project scoped — scan all projects. Same fallback as the rules
  // applicator does for `update_rule` without scope.
  const { readFleet } = await import("./fleet.js");
  const fleet = await readFleet();
  for (const proj of fleet.projects) {
    if (proj.status === "archived") continue;
    const list = await readProjectPersonas(proj.slug);
    const hit = list.find((p) => p.id === id);
    if (hit) return { persona: hit, scope: "project", project_slug: proj.slug };
  }
  return null;
}
