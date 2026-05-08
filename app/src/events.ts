import { apiBaseUrl } from "./baseUrl";
import { getToken, subscribeAuth } from "./auth";

/**
 * Tiny client for the server's `/v1/events` WebSocket fanout.
 *
 * Auto-reconnects with backoff. Exposes a `subscribe(handler)` API so any
 * caller can react to mutation_applied / chat_updated / etc. without each
 * one opening its own socket.
 */

interface CouncilRunEvent {
  project_slug: string;
  feature_id: string;
  run_id: string;
  run_type: string;
  ts: number;
}

export type IcarusEvent =
  | { type: "mutation_applied"; kind: string; payload: unknown; result: unknown; ts: number }
  | ({ type: "council_run_pending" } & CouncilRunEvent)
  | ({ type: "council_run_running" } & CouncilRunEvent)
  | ({ type: "council_run_completed" } & CouncilRunEvent)
  | ({ type: "council_run_failed"; error: string } & CouncilRunEvent)
  | { type: "queue_state_changed"; run: string; project_slug?: string; note?: string; ts: number }
  | { type: "task_started"; project_slug: string; task_id: string; run_id: string; title: string; ts: number }
  | { type: "task_progress"; project_slug: string; task_id: string; status: string; pills: number; retries: number; ts: number }
  | { type: "task_delta"; project_slug: string; task_id: string; delta: string; ts: number }
  | { type: "task_finished"; project_slug: string; task_id: string; run_id: string; status: string; ts: number }
  // Phase 15 — voice/chat-driven navigation. The originating client
  // honors only events whose `client_id` matches its own; other tabs
  // ignore the event. We forgo a fully-strict discriminated union on
  // `target.kind` here so the catch-all string-keyed fallback below
  // continues to swallow unknown future events.
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
  // Phase 19 — global voice toggle changed by the user (or the
  // agent). Clients flip the sidebar VoiceToggle pill state and
  // refresh `/v1/voice/health` immediately rather than waiting
  // for the next periodic poll.
  | { type: "voice_settings_changed"; disabled: boolean; ts: number }
  // Phase 20 — per-role model selection changed. Clients refresh
  // their Settings tab dropdowns + the dropdown surfaced in the
  // composer so all open tabs render the new selection
  // immediately.
  | { type: "model_settings_changed"; models: { chat: string; agent: string }; ts: number }
  | { type: string; [k: string]: unknown };

type Handler = (ev: IcarusEvent) => void;

let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let backoffMs = 500;
const handlers = new Set<Handler>();

function wsUrl(): string | null {
  const token = getToken();
  if (!token) return null;
  const base = apiBaseUrl();
  return base.replace(/^http/, "ws") + "/v1/events?token=" + encodeURIComponent(token);
}

function connect(): void {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  const url = wsUrl();
  if (!url) {
    // No token yet — `subscribeAuth` below will trigger a reconnect
    // attempt the moment the user signs in. Avoiding a noisy
    // reconnect-storm against an endpoint we know will 401.
    return;
  }
  try {
    socket = new WebSocket(url);
  } catch {
    scheduleReconnect();
    return;
  }
  socket.onopen = () => {
    backoffMs = 500;
  };
  socket.onmessage = (msg) => {
    let parsed: IcarusEvent | null = null;
    try {
      parsed = JSON.parse(typeof msg.data === "string" ? msg.data : "");
    } catch {
      return;
    }
    if (!parsed) return;
    for (const h of handlers) {
      try {
        h(parsed);
      } catch (err) {
        console.warn("event handler threw", err);
      }
    }
  };
  socket.onclose = () => {
    socket = null;
    scheduleReconnect();
  };
  socket.onerror = () => {
    socket?.close();
  };
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    backoffMs = Math.min(backoffMs * 2, 10_000);
    connect();
  }, backoffMs);
}

export function subscribe(handler: Handler): () => void {
  handlers.add(handler);
  connect();
  return () => {
    handlers.delete(handler);
  };
}

// React to login/logout: reconnect the socket as soon as a token
// appears, drop the connection cleanly when it goes away.
subscribeAuth((auth) => {
  if (auth) {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    backoffMs = 500;
    if (socket) {
      try {
        socket.close();
      } catch {
        // ignore
      }
      socket = null;
    }
    connect();
  } else if (socket) {
    try {
      socket.close();
    } catch {
      // ignore
    }
    socket = null;
  }
});
