/**
 * Queue + question domain types.
 *
 * Phase 9: the queue runs multiple workers in parallel inside the server
 * process. Each running task holds an in-memory lease keyed by task_id;
 * tasks with overlapping `resource_scope` won't run concurrently. On
 * server restart the queue boots `idle` and doesn't auto-resume tasks
 * that were in_progress — the user can manually flip them back to todo.
 */

export type QueueRunState = "idle" | "running" | "paused";

export interface QueueScope {
  /** If set, the picker only considers tasks for this project. */
  project_slug?: string;
}

export interface QueueState {
  run: QueueRunState;
  scope: QueueScope;
  /** ISO ms timestamp of the last state transition. */
  changed_at: number;
  /** Optional human note about why the queue was paused/stopped. */
  note?: string;
}

export type RunningTaskStatus =
  | "spawning"            // worker is launching cursor-agent
  | "running"             // cursor-agent is streaming output
  | "completed"           // task finished cleanly via complete_task
  | "failed"              // cursor-agent errored or no terminal verb arrived
  | "awaiting_question"   // agent emitted enqueue_question; user reply needed
  | "cancelled";          // user stopped/paused while running

/**
 * A snapshot of an in-flight task run. The output buffer is bounded — we
 * keep only the tail (the final ~200 KB) for the UI ticker, but each run
 * also persists its full transcript to disk so the user can review later.
 */
export interface RunningTask {
  task_id: string;
  project_slug: string;
  /** Title pulled at run-start so the UI doesn't have to look it up. */
  title: string;
  started_at: number;
  finished_at?: number;
  status: RunningTaskStatus;
  /** Current tail of the agent's stream. Capped to ~32 KB. */
  output_tail: string;
  /** Number of icarus pills the parser has emitted so far. */
  pills: number;
  /** Number of times we've had to retry due to schema/JSON failures. */
  retries: number;
  /** Last terminal error message if status === "failed". */
  error?: string;
  /** If status === "awaiting_question", the question id that's blocking. */
  blocking_question_id?: string;
}

export type QuestionStatus = "open" | "answered" | "dismissed";

export interface Question {
  id: string;
  project_slug: string;
  /** The task that asked the question. */
  task_id: string;
  /** The text the agent emitted. */
  body: string;
  /** Optional structured options: when present, the UI offers buttons. */
  options?: string[];
  asked_at: number;
  status: QuestionStatus;
  /** User's free-text answer (when status === "answered"). */
  answer?: string;
  /** Index into `options` if the user picked one. */
  answer_choice?: number;
  answered_at?: number;
  /** If the user dismissed without answering. */
  dismissed_at?: number;
}
