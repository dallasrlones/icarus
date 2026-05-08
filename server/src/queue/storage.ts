import fs from "node:fs/promises";
import path from "node:path";
import { ensureDir, readJsonOr, writeJson } from "../storage/json.js";
import {
  questionsFile,
  taskRunFile,
  taskRunsDir,
} from "../storage/paths.js";
import type { Question } from "./types.js";

/**
 * Per-project questions persisted under the wrapped `{ questions: [] }`
 * shape (mirrors features/tasks/flows for consistency). Volume is low —
 * single-user, async loop asks ~tens per project lifetime — so we just
 * read/modify/write the whole file under the project lock.
 */
interface QuestionsFile {
  questions: Question[];
}

export async function readQuestions(slug: string): Promise<Question[]> {
  const data = await readJsonOr<QuestionsFile>(questionsFile(slug), { questions: [] });
  return data.questions ?? [];
}

export async function writeQuestions(slug: string, questions: Question[]): Promise<void> {
  await writeJson(questionsFile(slug), { questions });
}

/**
 * Task run transcripts: full text of an agent's stream + the parsed pills,
 * one file per run. We don't enumerate them in normal UI flow; they're
 * archived for post-mortem inspection. The most recent run for a task is
 * also tracked in the in-memory `RunningTask` snapshot so the live UI
 * doesn't need to hit disk to render the ticker.
 */
export interface TaskRunRecord {
  id: string;
  task_id: string;
  project_slug: string;
  started_at: number;
  finished_at?: number;
  status: "running" | "completed" | "failed" | "awaiting_question" | "cancelled";
  prompt: string;
  raw_output: string;
  /** Pills extracted from the agent stream; same shape as chat pills. */
  pills: Array<{ kind?: string; result?: unknown; error?: string }>;
  error?: string;
  blocking_question_id?: string;
}

export async function saveTaskRun(record: TaskRunRecord): Promise<void> {
  const file = taskRunFile(record.project_slug, record.task_id, record.id);
  await ensureDir(path.dirname(file));
  await writeJson(file, record);
}

export async function listTaskRuns(slug: string, taskId: string): Promise<TaskRunRecord[]> {
  const dir = taskRunsDir(slug);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: TaskRunRecord[] = [];
  const prefix = `${taskId}-`;
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(path.join(dir, name), "utf8");
      out.push(JSON.parse(raw) as TaskRunRecord);
    } catch {
      // Skip corrupt files.
    }
  }
  out.sort((a, b) => b.started_at - a.started_at);
  return out;
}
