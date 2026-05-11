import fs from "node:fs";
import os from "node:os";
import type { RawData } from "ws";
import { WebSocket } from "ws";
import { spawn } from "node-pty";
import { workspaceFor } from "../code/files.js";

const SHELL_BIN = (process.env.ICARUS_SHELL ?? "").trim() || "/bin/bash";
/** Effective HOME / "~" for the global cockpit shell (container default: `/root`). */
const GLOBAL_SHELL_CWD = (process.env.ICARUS_SHELL_GLOBAL_CWD ?? "").trim() || os.homedir();

function clampInt(n: number, lo: number, hi: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, Math.floor(n)));
}

function rawToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (typeof data === "string") return Buffer.from(data, "utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return Buffer.from(String(data));
}

export async function bindShellConnection(ws: WebSocket, reqUrl: URL): Promise<void> {
  const scope = reqUrl.searchParams.get("scope") ?? "";
  const slug = reqUrl.searchParams.get("slug");
  const cols = clampInt(Number(reqUrl.searchParams.get("cols")), 40, 200, 120);
  const rows = clampInt(Number(reqUrl.searchParams.get("rows")), 10, 80, 28);

  let cwd: string;
  try {
    if (scope === "global") {
      cwd = fs.realpathSync(GLOBAL_SHELL_CWD);
    } else if (scope === "project") {
      if (!slug || slug.length === 0) {
        ws.close(4000, "slug required");
        return;
      }
      cwd = await workspaceFor(slug);
    } else {
      ws.close(4000, "invalid scope");
      return;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "cwd failed";
    ws.close(4002, msg.slice(0, 120));
    return;
  }

  let term;
  try {
    term = spawn(SHELL_BIN, [], {
      name: "xterm-256color",
      cwd,
      cols,
      rows,
      env: { ...process.env, TERM: "xterm-256color" } as Record<string, string>,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "spawn failed";
    ws.close(4003, msg.slice(0, 120));
    return;
  }

  let cleaned = false;
  const detachData = term.onData((data) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  });

  const dispose = () => {
    if (cleaned) return;
    cleaned = true;
    detachData.dispose();
    try {
      term.kill();
    } catch {
      /* ignore */
    }
  };

  term.onExit(() => {
    dispose();
    try {
      if (ws.readyState === WebSocket.OPEN) ws.close(1000);
    } catch {
      /* ignore */
    }
  });

  ws.on("message", (data: RawData, isBinary: boolean) => {
    try {
      if (isBinary) {
        const buf = rawToBuffer(data);
        term.write(buf);
        return;
      }
      const text = rawToBuffer(data).toString("utf8");
      const msg = JSON.parse(text) as { type?: string; cols?: number; rows?: number };
      if (msg.type === "resize") {
        const c = clampInt(Number(msg.cols), 40, 200, cols);
        const r = clampInt(Number(msg.rows), 10, 80, rows);
        term.resize(c, r);
      }
    } catch {
      /* ignore malformed resize payloads */
    }
  });

  ws.on("close", dispose);
}
