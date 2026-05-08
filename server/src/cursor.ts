import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";

/**
 * Thin wrapper around the `cursor-agent` CLI.
 *
 * Auth is whatever the CLI itself sees — we never pass an API key. The user
 * either logs in interactively (`cursor-agent login`) on the host, in the
 * container, or has a pre-existing CURSOR_AUTH_TOKEN in the environment that
 * the CLI will pick up on its own.
 */

export interface CursorOptions {
  /** Absolute path or PATH-resolvable name of the cursor-agent CLI. */
  binary: string;
  /** Workspace directory the agent operates against. */
  cwd: string;
  /** Optional model id (`composer-2`, `auto`, …). */
  model?: string;
  /** If true, pass --force so tool calls can actually mutate files. */
  allowFileWrites?: boolean;
}

/**
 * Streamed event shape we emit upstream. We unify the (verbose) cursor-agent
 * stream-json schema into something the HTTP layer can forward without caring
 * about the underlying protocol.
 */
export type CursorEvent =
  | { kind: "init"; model?: string }
  | { kind: "delta"; text: string }
  | { kind: "tool"; name: string; phase: "started" | "completed"; detail?: string }
  | { kind: "result"; durationMs?: number }
  | { kind: "error"; message: string };

/**
 * Spawn `cursor-agent create-chat` and return the new chat id.
 *
 * The CLI prints the UUID and then hangs (it doesn't self-terminate after the
 * single line of output, at least as of 2026.05.01). We read stdout
 * incrementally, grab the first UUID-shaped line, and kill the child.
 */
export async function createChat(opts: CursorOptions): Promise<string> {
  const child = spawn(opts.binary, ["create-chat"], {
    cwd: opts.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });

  const UUID = /^[0-9a-fA-F-]{36}$/;
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c: string) => (stderr += c));

  const id = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`cursor-agent create-chat timed out: ${stderr.trim().slice(0, 300)}`));
      child.kill("SIGTERM");
    }, 15_000);

    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      for (const line of stdout.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (UUID.test(trimmed)) {
          clearTimeout(timer);
          resolve(trimmed);
          // Best-effort terminate; create-chat does not self-exit.
          child.kill("SIGTERM");
          setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
          return;
        }
      }
    });

    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (stdout.trim().length === 0) {
        reject(
          new Error(
            `cursor-agent create-chat exited (${code}) with no id: ${stderr.trim().slice(0, 300)}`,
          ),
        );
      }
    });
  });

  return id;
}

/**
 * Send a single user turn to a chat. Yields normalized events as they arrive
 * from the CLI's stream-json output.
 */
export async function* sendTurn(
  opts: CursorOptions,
  chatId: string,
  prompt: string,
  signal?: AbortSignal,
): AsyncGenerator<CursorEvent, void, void> {
  const args = [
    "--print",
    "--output-format",
    "stream-json",
    "--stream-partial-output",
    "--trust",
    "--resume",
    chatId,
  ];
  if (opts.model) args.push("--model", opts.model);
  if (opts.allowFileWrites) args.push("--force");
  args.push(prompt);

  const child = spawn(opts.binary, args, {
    cwd: opts.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  if (signal) {
    const onAbort = () => child.kill("SIGTERM");
    signal.addEventListener("abort", onAbort, { once: true });
    child.once("close", () => signal.removeEventListener("abort", onAbort));
  }
  // Surface ENOENT / ENOTDIR with the actionable detail (which
  // path was missing — usually it's the cwd, not the binary, but
  // Node's default error message says only "spawn cursor-agent
  // ENOENT" which sends people debugging the wrong thing).
  child.once("error", (err) => {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT" || e.code === "ENOTDIR") {
      console.error(
        `[cursor sendTurn] spawn ${e.code}: cwd=${opts.cwd} binary=${opts.binary} (cwd exists=${existsSync(opts.cwd)})`,
      );
    }
  });

  let stderrBuf = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderrBuf += chunk;
    if (process.env.CURSOR_DEBUG) process.stderr.write(`[cursor stderr] ${chunk}`);
  });

  let buffer = "";
  child.stdout.setEncoding("utf8");
  if (process.env.CURSOR_DEBUG) {
    console.error(`[cursor spawn] ${opts.binary} ${args.map((a) => JSON.stringify(a)).join(" ")}`);
  }

  const queue: CursorEvent[] = [];
  let done = false;
  let error: Error | null = null;
  let resolveNext: (() => void) | null = null;

  const wake = () => {
    const fn = resolveNext;
    resolveNext = null;
    fn?.();
  };

  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    if (process.env.CURSOR_DEBUG) process.stderr.write(`[cursor stdout] ${chunk}`);
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      const event = parseLine(trimmed);
      if (event) queue.push(event);
      else if (process.env.CURSOR_DEBUG) {
        console.error(`[cursor parse miss] ${trimmed.slice(0, 200)}`);
      }
    }
    wake();
  });

  child.once("error", (err) => {
    error = err;
    done = true;
    wake();
  });

  child.once("close", (code) => {
    if (buffer.length > 0) {
      const event = parseLine(buffer.trim());
      if (event) queue.push(event);
      buffer = "";
    }
    if (code !== 0 && code !== null) {
      const detail = stderrBuf.trim().slice(0, 500) || `exit ${code}`;
      queue.push({ kind: "error", message: detail });
    }
    done = true;
    wake();
  });

  while (true) {
    if (queue.length > 0) {
      yield queue.shift()!;
      continue;
    }
    if (done) break;
    await new Promise<void>((resolve) => {
      resolveNext = resolve;
    });
  }

  if (error) throw error;
}

interface RawAssistantEvent {
  type: "assistant";
  message?: { content?: Array<{ type?: string; text?: string }> };
  timestamp_ms?: number;
  model_call_id?: string;
}
interface RawSystemEvent {
  type: "system";
  subtype?: string;
  model?: string;
}
interface RawToolEvent {
  type: "tool_call";
  subtype?: "started" | "completed";
  tool_call?: Record<string, { args?: { path?: string } }>;
}
interface RawResultEvent {
  type: "result";
  duration_ms?: number;
  is_error?: boolean;
  error?: string;
}
type RawEvent = RawAssistantEvent | RawSystemEvent | RawToolEvent | RawResultEvent;

function parseLine(line: string): CursorEvent | null {
  if (!line.startsWith("{")) return null;
  let raw: RawEvent;
  try {
    raw = JSON.parse(line) as RawEvent;
  } catch {
    return null;
  }
  switch (raw.type) {
    case "system":
      if (raw.subtype === "init") return { kind: "init", model: raw.model };
      return null;
    case "assistant": {
      // Per cursor-agent docs: streaming deltas have timestamp_ms but no
      // model_call_id. Buffered flushes (which we'd otherwise double-count)
      // have model_call_id; skip them.
      if (raw.timestamp_ms === undefined || raw.model_call_id !== undefined) return null;
      const text = raw.message?.content?.[0]?.text ?? "";
      if (!text) return null;
      return { kind: "delta", text };
    }
    case "tool_call": {
      const phase = raw.subtype;
      if (phase !== "started" && phase !== "completed") return null;
      const [name, payload] = Object.entries(raw.tool_call ?? {})[0] ?? [];
      const detail = payload?.args?.path;
      return { kind: "tool", phase, name: name ?? "tool", detail };
    }
    case "result":
      if (raw.is_error) return { kind: "error", message: raw.error ?? "agent reported error" };
      return { kind: "result", durationMs: raw.duration_ms };
    default:
      return null;
  }
}

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

async function runToCompletion(
  binary: string,
  args: string[],
  opts: { cwd: string },
): Promise<RunResult> {
  const child = spawn(binary, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (c: string) => (stdout += c));
  child.stderr.on("data", (c: string) => (stderr += c));
  const [code] = (await once(child, "close")) as [number | null];
  if (code !== 0) {
    throw new Error(
      `cursor-agent ${args.join(" ")} failed (exit ${code}): ${stderr.trim().slice(0, 500)}`,
    );
  }
  return { stdout, stderr, code: code ?? 0 };
}

/**
 * Stateless one-shot invocation: creates a fresh chat, sends one prompt,
 * collects the entire assistant response into a single string, and
 * resolves. Useful for the Council runner — these invocations are
 * stateless by design (no chat memory, no resumed session).
 *
 * Errors propagate. If the agent emits a `result` with `is_error`, this
 * rejects with the message; if the underlying child exits non-zero we
 * also reject with stderr.
 */
export async function runOneShot(
  opts: CursorOptions,
  prompt: string,
  signal?: AbortSignal,
): Promise<{ text: string; durationMs?: number }> {
  const chatId = await createChat(opts);
  let text = "";
  let durationMs: number | undefined;
  for await (const ev of sendTurn(opts, chatId, prompt, signal)) {
    switch (ev.kind) {
      case "delta":
        text += ev.text;
        break;
      case "result":
        durationMs = ev.durationMs;
        break;
      case "error":
        throw new Error(`cursor-agent error: ${ev.message}`);
      default:
        break;
    }
  }
  return { text, durationMs };
}

/** Cheap probe used by /health to surface install/auth issues early. */
export async function probe(
  opts: CursorOptions,
): Promise<{ version: string; auth: "api-key" | "stored-login" | "none" }> {
  const ver = await runToCompletion(opts.binary, ["--version"], { cwd: opts.cwd });
  let auth: "api-key" | "stored-login" | "none" = "none";
  if (process.env.CURSOR_API_KEY) {
    auth = "api-key";
  } else {
    try {
      const status = await runToCompletion(opts.binary, ["status"], { cwd: opts.cwd });
      auth = /not logged in/i.test(status.stdout + status.stderr) ? "none" : "stored-login";
    } catch {
      auth = "none";
    }
  }
  return { version: ver.stdout.trim(), auth };
}
