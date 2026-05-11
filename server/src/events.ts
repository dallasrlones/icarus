import type { IncomingMessage, Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { authenticateUpgrade } from "./auth/ws.js";
import { bindShellConnection } from "./shell/session.js";

/**
 * Single-tenant WebSocket upgrade multiplexer:
 * - `/v1/events` — mutation / queue / task fan-out bus for UI subscribers.
 * - `/v1/shell` — JWT-auth interactive PTY (`node-pty`) for the Shell tab.
 *
 * No topic subscriptions yet — event filtering stays client-side.
 */

export type IcarusEvent =
  | { type: "mutation_applied"; kind: string; payload: unknown; result: unknown; ts: number }
  | { type: "council_run_pending"; project_slug: string; feature_id: string; run_id: string; run_type: string; ts: number }
  | { type: "council_run_running"; project_slug: string; feature_id: string; run_id: string; run_type: string; ts: number }
  | { type: "council_run_completed"; project_slug: string; feature_id: string; run_id: string; run_type: string; ts: number }
  | { type: "council_run_failed"; project_slug: string; feature_id: string; run_id: string; run_type: string; error: string; ts: number }
  // Phase 18 — emitted whenever the council auto-fires an
  // approve_* mutation off its own verdict. Decoupled from
  // council_run_completed so UI subscribers can show a
  // distinct toast ("council auto-approved your flow") instead
  // of confusing the user about who clicked Approve.
  | {
      type: "council_auto_decided";
      project_slug: string;
      feature_id: string;
      run_id: string;
      run_type: string;
      verdict: "approve" | "approve_with_notes" | "request_changes";
      applied: "approve_flow" | "approve_tasks" | "approve_architecture";
      ts: number;
    }
  // Phase 19 — voice user toggle. Fires whenever the user (or the
  // agent) flips the global voice on/off setting; clients update
  // their voice availability state without waiting for their next
  // /v1/voice/health poll.
  | { type: "voice_settings_changed"; disabled: boolean; ts: number }
  // Phase 20 — global model selection changed (chat / agent role).
  // Clients refresh their `/v1/settings/models` view + flip the
  // dropdown in the Settings tab so all open tabs stay in sync.
  | { type: "model_settings_changed"; models: { chat: string; agent: string }; ts: number }
  | { type: "queue_state_changed"; run: string; project_slug?: string; note?: string; ts: number }
  | { type: "task_started"; project_slug: string; task_id: string; run_id: string; title: string; ts: number }
  | { type: "task_progress"; project_slug: string; task_id: string; status: string; pills: number; retries: number; ts: number }
  | { type: "task_delta"; project_slug: string; task_id: string; delta: string; ts: number }
  | { type: "task_finished"; project_slug: string; task_id: string; run_id: string; status: string; ts: number }
  // Phase 15 — voice / chat-driven navigation. The agent emits a
  // `navigate` mutation; the applicator broadcasts this event with
  // the originating client_id so only that client honors it. (The
  // event still goes to every WS client — they each compare the
  // client_id to their own and ignore mismatches.)
  | {
      type: "nav_request";
      client_id?: string;
      target:
        | { kind: "global"; tab?: string }
        | { kind: "project"; project_slug: string; tab?: string }
        | { kind: "feature"; project_slug: string; feature_id: string }
        | { kind: "task"; project_slug: string; task_id: string };
      reason?: string;
      ts: number;
    }
  | { type: "ping"; ts: number };

/**
 * Server-side listener for events. Returned from `events.subscribe()`;
 * call the returned function to unsubscribe.
 */
export type EventListener = (event: IcarusEvent) => void;

class EventBus {
  private wss: WebSocketServer | null = null;
  /** JWT-auth interactive shells (`/v1/shell`). */
  private shellWss: WebSocketServer | null = null;
  /**
   * In-process listeners. Used by API endpoints that need to wait on
   * lifecycle events without the WS round-trip (e.g. the synchronous
   * tool-run endpoint blocking on `task_finished`). Listeners run
   * synchronously inside `broadcast` — they must be cheap and must not
   * throw (errors are caught and logged).
   */
  private listeners = new Set<EventListener>();

  attach(server: Server): void {
    if (this.wss) return;
    // `noServer: true` lets us hand-roll the upgrade auth check —
    // anything without a valid `?token=` JWT gets a 401 and the
    // socket never opens.
    this.wss = new WebSocketServer({ noServer: true });
    this.wss.on("connection", (ws: WebSocket) => {
      ws.send(JSON.stringify({ type: "ping", ts: Date.now() } satisfies IcarusEvent));
    });

    this.shellWss = new WebSocketServer({ noServer: true });
    this.shellWss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
      const reqUrl = new URL(req.url ?? "", "http://localhost");
      void bindShellConnection(ws, reqUrl);
    });

    server.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const pathname = url.pathname;
      const claims = authenticateUpgrade(req);
      if (!claims) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      if (pathname === "/v1/events") {
        this.wss?.handleUpgrade(req, socket, head, (ws) => {
          this.wss?.emit("connection", ws, req);
        });
        return;
      }
      if (pathname === "/v1/shell") {
        this.shellWss?.handleUpgrade(req, socket, head, (ws) => {
          this.shellWss?.emit("connection", ws, req);
        });
        return;
      }
      socket.destroy();
    });
  }

  broadcast(event: IcarusEvent): void {
    // Fan out to in-process listeners first — they're authoritative for
    // server-to-server flows (sync tool runs, etc.) and shouldn't be
    // delayed waiting for sockets.
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error("[events] listener threw:", err);
      }
    }
    if (!this.wss) return;
    const payload = JSON.stringify(event);
    for (const ws of this.wss.clients) {
      if (ws.readyState === ws.OPEN) ws.send(payload);
    }
  }

  /**
   * Subscribe to every broadcast event. Returns an unsubscribe function;
   * always call it (even on error paths) to avoid leaking listeners.
   */
  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

export const events = new EventBus();

/**
 * Block until a `task_finished` event for the given task lands, or
 * `timeoutMs` elapses. Resolves with the event on success, or `null`
 * on timeout. Used by the synchronous tool-run endpoint.
 *
 * Always cleans up the listener — including the timeout-cancel path —
 * so callers don't have to think about it.
 */
export function awaitTaskFinish(
  taskId: string,
  timeoutMs: number,
): Promise<Extract<IcarusEvent, { type: "task_finished" }> | null> {
  return new Promise((resolve) => {
    let unsubscribe = () => {};
    const timer = setTimeout(() => {
      unsubscribe();
      resolve(null);
    }, timeoutMs);
    unsubscribe = events.subscribe((event) => {
      if (event.type !== "task_finished") return;
      if (event.task_id !== taskId) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(event);
    });
  });
}
