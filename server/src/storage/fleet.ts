import { fleetFile } from "./paths.js";
import { readJsonOr, writeJson } from "./json.js";

export interface ProjectListing {
  slug: string;
  name: string;
  description?: string;
  workspace_path?: string;
  status: "active" | "archived";
  created_at: number;
  updated_at: number;
}

export interface Fleet {
  projects: ProjectListing[];
}

const EMPTY_FLEET: Fleet = { projects: [] };

export async function readFleet(): Promise<Fleet> {
  return await readJsonOr<Fleet>(fleetFile(), { ...EMPTY_FLEET });
}

export async function writeFleet(fleet: Fleet): Promise<void> {
  await writeJson(fleetFile(), fleet);
}
