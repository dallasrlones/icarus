import type { ToolProposal } from "../domain.js";
import { readJsonOr, writeJson } from "./json.js";
import { toolProposalsFile } from "./paths.js";

/**
 * Phase 13 — disk-backed reads/writes for the global tool-proposal
 * registry (`store/tool_proposals.json`).
 *
 * Same `{ proposals: [...] }` envelope used by tools/cron/rules. Reads
 * always pass a *fresh* fallback object to `readJsonOr` because
 * applicators mutate the returned array in place — module-level
 * shared defaults would cross-contaminate writes (the same bug class
 * I hit during the rules smoke).
 */

interface ProposalsFile {
  proposals: ToolProposal[];
}

export async function readToolProposals(): Promise<ToolProposal[]> {
  const data = await readJsonOr<ProposalsFile>(toolProposalsFile(), { proposals: [] });
  return Array.isArray(data.proposals) ? data.proposals : [];
}

export async function writeToolProposals(proposals: ToolProposal[]): Promise<void> {
  await writeJson(toolProposalsFile(), { proposals });
}

export async function findToolProposalById(id: string): Promise<ToolProposal | null> {
  const all = await readToolProposals();
  return all.find((p) => p.id === id) ?? null;
}
