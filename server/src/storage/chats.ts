import type { Chat, ChatSummary } from "../types.js";
import {
  globalChatFile,
  globalChatsIndex,
  projectChatFile,
  projectChatsIndex,
} from "./paths.js";
import { readJsonOr, rm, writeJson } from "./json.js";

/**
 * Disk-backed chat persistence. Scope-aware: a chat is either at the
 * global root or scoped to a single project.
 *
 * Source of truth split:
 *   - `index.json` keeps a list of summaries for fast sidebar rendering.
 *   - Each chat lives at `<id>.json` with the full message log + cursor
 *     chat id.
 *
 * Locking is the *caller's* responsibility (use `chatLocks.run("<scope>:<id>",
 * …)` for read-modify-write sequences). Keeping the lock above this layer
 * lets `chats.ts` hold the lock across both load and save without
 * deadlocking on a re-entrant inner lock.
 */

export type ChatScope = { kind: "global" } | { kind: "project"; slug: string };

export interface MemoryEntry {
  kind: string;
  summary: string;
  ts: number;
  /**
   * `applied`           — mutation succeeded (default; older entries omit).
   * `rejected_terminal` — agent burned its retry budget without producing
   *                       a valid block; surfaced to the next turn so the
   *                       agent and (later) the council can react.
   */
  outcome?: "applied" | "rejected_terminal";
}

export interface PersistedChat extends Chat {
  cursorChatId: string;
  /**
   * Mutations applied during the most recent assistant turn. Read at the
   * start of the next turn so the agent can see what its last reply
   * actually changed; cleared after being injected.
   */
  pendingMemory?: MemoryEntry[];
}

interface IndexEntry extends ChatSummary {
  cursorChatId: string;
}

interface IndexFile {
  chats: IndexEntry[];
}

const EMPTY_INDEX: IndexFile = { chats: [] };

export function lockKey(scope: ChatScope, id: string): string {
  return scope.kind === "global" ? `global:${id}` : `project:${scope.slug}:${id}`;
}

function indexFor(scope: ChatScope): string {
  return scope.kind === "global"
    ? globalChatsIndex()
    : projectChatsIndex(scope.slug);
}

function fileFor(scope: ChatScope, id: string): string {
  return scope.kind === "global" ? globalChatFile(id) : projectChatFile(scope.slug, id);
}

export async function listChats(scope: ChatScope): Promise<ChatSummary[]> {
  const idx = await readJsonOr<IndexFile>(indexFor(scope), EMPTY_INDEX);
  return idx.chats
    .map(({ cursorChatId: _ignored, ...summary }) => summary)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function loadChat(scope: ChatScope, id: string): Promise<PersistedChat | null> {
  return await readJsonOr<PersistedChat | null>(fileFor(scope, id), null);
}

export async function saveChat(scope: ChatScope, chat: PersistedChat): Promise<void> {
  await writeJson(fileFor(scope, chat.id), chat);
  await upsertIndexEntry(scope, {
    id: chat.id,
    title: chat.title,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    messageCount: chat.messageCount,
    cursorChatId: chat.cursorChatId,
  });
}

export async function deleteChat(scope: ChatScope, id: string): Promise<boolean> {
  const existed = await rm(fileFor(scope, id));
  const idx = await readJsonOr<IndexFile>(indexFor(scope), { ...EMPTY_INDEX });
  const before = idx.chats.length;
  idx.chats = idx.chats.filter((c) => c.id !== id);
  if (idx.chats.length !== before) {
    await writeJson(indexFor(scope), idx);
  }
  return existed || idx.chats.length !== before;
}

async function upsertIndexEntry(scope: ChatScope, entry: IndexEntry): Promise<void> {
  const idx = await readJsonOr<IndexFile>(indexFor(scope), { ...EMPTY_INDEX });
  const i = idx.chats.findIndex((c) => c.id === entry.id);
  if (i >= 0) idx.chats[i] = entry;
  else idx.chats.unshift(entry);
  idx.chats.sort((a, b) => b.updatedAt - a.updatedAt);
  await writeJson(indexFor(scope), idx);
}
