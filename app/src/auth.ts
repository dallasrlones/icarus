import { apiBaseUrl } from "./api";

/**
 * Client-side auth state. The server is the source of truth for the
 * JWT (we just stash it in localStorage and pin it to every API
 * request). On 401 we clear the token and notify subscribers so the
 * shell can flip back to the login screen without a page reload.
 *
 * Single-tab single-user shop right now — no refresh-token dance,
 * tokens default to 7d and the user signs in again when they expire.
 */

const STORAGE_KEY = "icarus.auth.v1";

export interface AuthUser {
  id: string;
  username: string;
  must_change_password: boolean;
  last_login_at: string | null;
  created_at?: string;
  updated_at?: string;
}

interface PersistedAuth {
  token: string;
  user: AuthUser;
}

function safeStorage(): Storage | null {
  try {
    if (typeof globalThis !== "undefined" && (globalThis as { localStorage?: Storage }).localStorage) {
      return (globalThis as { localStorage: Storage }).localStorage;
    }
  } catch {
    // restricted environment (private browsing, RN before storage shim, …)
  }
  return null;
}

let cached: PersistedAuth | null = null;
let cacheLoaded = false;

function loadFromStorage(): PersistedAuth | null {
  if (cacheLoaded) return cached;
  cacheLoaded = true;
  const store = safeStorage();
  if (!store) return null;
  try {
    const raw = store.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedAuth;
    if (typeof parsed?.token !== "string" || !parsed.user) return null;
    cached = parsed;
    return cached;
  } catch {
    return null;
  }
}

function persist(auth: PersistedAuth | null): void {
  cached = auth;
  cacheLoaded = true;
  const store = safeStorage();
  if (!store) return;
  if (auth) store.setItem(STORAGE_KEY, JSON.stringify(auth));
  else store.removeItem(STORAGE_KEY);
}

type Listener = (auth: PersistedAuth | null) => void;
const listeners = new Set<Listener>();

function notify(): void {
  for (const fn of listeners) {
    try {
      fn(cached);
    } catch (err) {
      console.warn("[auth] listener threw", err);
    }
  }
}

export function subscribeAuth(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function getToken(): string | null {
  const auth = loadFromStorage();
  return auth?.token ?? null;
}

export function getCurrentUser(): AuthUser | null {
  const auth = loadFromStorage();
  return auth?.user ?? null;
}

export function isAuthenticated(): boolean {
  return getToken() !== null;
}

/**
 * Called from `authFetch` whenever the server reports the token is
 * missing/invalid/expired. Drops local state and pings subscribers
 * so the shell renders the login screen.
 */
export function clearAuth(): void {
  if (cached === null && cacheLoaded) return;
  persist(null);
  notify();
}

interface LoginResponse {
  token: string;
  user: AuthUser;
}

export async function login(username: string, password: string): Promise<AuthUser> {
  const res = await fetch(`${apiBaseUrl()}/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const body = (await res.json().catch(() => ({}))) as LoginResponse & { error?: string };
  if (!res.ok || !body.token) {
    throw new Error(body?.error ?? "invalid credentials");
  }
  persist({ token: body.token, user: body.user });
  notify();
  return body.user;
}

export async function logout(): Promise<void> {
  const token = getToken();
  if (token) {
    await fetch(`${apiBaseUrl()}/v1/auth/logout`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => undefined);
  }
  clearAuth();
}

export async function changePassword(
  currentPassword: string,
  newPassword: string,
): Promise<AuthUser> {
  const token = getToken();
  if (!token) throw new Error("not signed in");
  const res = await fetch(`${apiBaseUrl()}/v1/auth/change-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
  });
  const body = (await res.json().catch(() => ({}))) as LoginResponse & { error?: string };
  if (!res.ok || !body.token) {
    throw new Error(body?.error ?? "failed to change password");
  }
  persist({ token: body.token, user: body.user });
  notify();
  return body.user;
}

/**
 * Refresh the cached user from the server. Useful after the WS
 * reports activity that might have changed `must_change_password`
 * (admin reset etc.). On 401 we drop local auth.
 */
export async function refreshMe(): Promise<AuthUser | null> {
  const token = getToken();
  if (!token) return null;
  const res = await fetch(`${apiBaseUrl()}/v1/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) {
    clearAuth();
    return null;
  }
  if (!res.ok) return cached?.user ?? null;
  const body = (await res.json()) as { user: AuthUser };
  if (body?.user) {
    persist({ token, user: body.user });
    notify();
    return body.user;
  }
  return null;
}

/**
 * Wrapper around `fetch` that pins the JWT and turns 401 responses
 * into a single `clearAuth()` call. All client-side API helpers
 * funnel through this so we stay one round-trip away from "kick to
 * login" if the token expires mid-session.
 */
export async function authFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const token = getToken();
  const headers = new Headers(init.headers ?? undefined);
  if (token && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  const res = await fetch(input, { ...init, headers });
  if (res.status === 401) {
    // Clone defensively so callers can still inspect the body for
    // their own diagnostics — `clearAuth` just trips the listeners.
    clearAuth();
  }
  return res;
}
