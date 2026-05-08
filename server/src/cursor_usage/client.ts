/**
 * Phase 17 — Cursor usage panel.
 *
 * Cursor doesn't expose a stable usage API to individual API keys
 * (the `crsr_…` token your `cursor-agent` runs on is for execution,
 * not billing). The Admin API at `api.cursor.com/teams/*` is gated
 * behind Team/Enterprise plans and a separate admin key.
 *
 * The web dashboard at `cursor.com/dashboard` and the various
 * community usage extensions all hit an *undocumented* Connect-RPC
 * service at `api2.cursor.sh/aiserver.v1.DashboardService/*`,
 * authenticated with an Auth0 JWT issued to the Cursor desktop
 * app. That JWT lives in the desktop's SQLite store at
 * `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`.
 *
 * This module:
 *   1. Reads `accessToken` + `refreshToken` from that SQLite file
 *      via the `sqlite3` CLI (no node-native dep — keeps the
 *      runtime image lean).
 *   2. Tries the dashboard service. If the access token is
 *      expired (Auth0 returns 401), refreshes via
 *      `POST https://api2.cursor.sh/oauth/token`.
 *   3. NEVER writes the refreshed token back to SQLite — we don't
 *      want to corrupt the desktop's auth state. The new token is
 *      held purely in memory; the desktop has its own refresh
 *      cycle that will see the same refresh token and update the
 *      file independently.
 *   4. Caches results for 5 minutes (the dashboard service is
 *      undocumented and we don't want to hammer it).
 *
 * The module is best-effort: if SQLite isn't available, if the
 * desktop isn't installed, if the JWT can't be refreshed — we
 * return an `unavailable` envelope with a human-readable reason
 * and a link to `cursor.com/dashboard`. The UI shows a friendly
 * "couldn't load — open dashboard" pill instead of the gauge.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DASHBOARD_BASE = "https://api2.cursor.sh";
const AUTH0_CLIENT_ID = "KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB";
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Resolve the desktop's `state.vscdb` path. Order:
 *   1. CURSOR_DESKTOP_PATH env override (full path to a `.vscdb`).
 *   2. Docker bind mount at `/cursor-app/User/globalStorage/state.vscdb`.
 *   3. Native macOS path under `$HOME/Library/Application Support/Cursor`.
 *
 * Returns `null` when none of the candidates exists; callers
 * surface the reason in the unavailable envelope.
 */
function resolveStatePath(): string | null {
  const env = process.env.CURSOR_DESKTOP_PATH;
  if (env && existsSync(env)) return env;
  const dockerMount = "/cursor-app/User/globalStorage/state.vscdb";
  if (existsSync(dockerMount)) return dockerMount;
  const native = join(
    homedir(),
    "Library/Application Support/Cursor/User/globalStorage/state.vscdb",
  );
  if (existsSync(native)) return native;
  return null;
}

interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  membershipType: string | null;
}

/**
 * Read tokens via the `sqlite3` CLI. Values in the desktop store
 * are JSON-encoded strings (so a token shows up as `"eyJ…"`); we
 * strip the wrapping quotes when present.
 */
function readTokens(statePath: string): TokenSet | null {
  const result = spawnSync(
    "sqlite3",
    [
      statePath,
      "SELECT key, value FROM ItemTable WHERE key IN ('cursorAuth/accessToken','cursorAuth/refreshToken','cursorAuth/stripeMembershipType')",
    ],
    { encoding: "utf8", timeout: 5000 },
  );
  if (result.status !== 0) return null;

  const tokens: Partial<Record<string, string>> = {};
  for (const line of result.stdout.split("\n")) {
    const idx = line.indexOf("|");
    if (idx === -1) continue;
    const key = line.slice(0, idx);
    const raw = line.slice(idx + 1);
    let value = raw;
    if (value.startsWith('"') && value.endsWith('"')) {
      try {
        value = JSON.parse(value);
      } catch {
        value = value.slice(1, -1);
      }
    }
    tokens[key] = value;
  }

  const access = tokens["cursorAuth/accessToken"];
  if (!access) return null;
  return {
    accessToken: access,
    refreshToken: tokens["cursorAuth/refreshToken"] ?? null,
    membershipType: tokens["cursorAuth/stripeMembershipType"] ?? null,
  };
}

/**
 * In-memory token cache. Persists the last-known-good access
 * token (possibly already refreshed) so subsequent calls within
 * the same process don't re-read SQLite or re-hit the refresh
 * endpoint until the new token actually expires.
 */
let cachedToken: { value: string; refreshToken: string | null; expiresAt: number } | null = null;

function decodeJwtExp(jwt: string): number | null {
  const parts = jwt.split(".");
  if (parts.length < 2) return null;
  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "===".slice((base64.length + 3) % 4);
    const payload = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
    if (typeof payload.exp === "number") return payload.exp * 1000;
  } catch {
    /* fall through */
  }
  return null;
}

async function refreshAccessToken(refreshToken: string): Promise<string> {
  const res = await fetch(`${DASHBOARD_BASE}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: AUTH0_CLIENT_ID,
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) {
    throw new Error(`oauth/token returned HTTP ${res.status}`);
  }
  const body = (await res.json()) as {
    access_token?: string;
    shouldLogout?: boolean;
  };
  if (body.shouldLogout) {
    throw new Error("refresh token rejected — re-login on the Cursor desktop app");
  }
  if (!body.access_token) {
    throw new Error("oauth/token returned no access_token");
  }
  return body.access_token;
}

/**
 * Returns a fresh, valid access token. Reads from SQLite if the
 * cache is empty or stale; refreshes via Auth0 when the cached
 * token is within 60s of expiry.
 */
async function getAccessToken(): Promise<{ token: string; membershipType: string | null }> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt - now > 60_000) {
    return { token: cachedToken.value, membershipType: null };
  }

  const statePath = resolveStatePath();
  if (!statePath) {
    throw new Error(
      "Cursor desktop SQLite not found — set CURSOR_DESKTOP_PATH or bind-mount the desktop dir",
    );
  }
  const tokens = readTokens(statePath);
  if (!tokens) {
    throw new Error(`failed to read tokens from ${statePath}`);
  }

  let access = tokens.accessToken;
  let exp = decodeJwtExp(access);
  // Refresh if the SQLite token is itself expired or about to be.
  if (exp !== null && exp - now < 60_000) {
    if (!tokens.refreshToken) {
      throw new Error(
        "access token expired and no refresh token in desktop store — re-login on Cursor",
      );
    }
    access = await refreshAccessToken(tokens.refreshToken);
    exp = decodeJwtExp(access);
  }
  cachedToken = {
    value: access,
    refreshToken: tokens.refreshToken,
    expiresAt: exp ?? now + 30 * 60 * 1000, // fallback: assume 30min if exp missing
  };
  return { token: access, membershipType: tokens.membershipType };
}

interface DashboardCallOpts {
  retryOn401?: boolean;
}

async function callDashboard<T>(
  endpoint: string,
  body: unknown,
  opts: DashboardCallOpts = {},
): Promise<T> {
  const { token } = await getAccessToken();
  const res = await fetch(`${DASHBOARD_BASE}/aiserver.v1.DashboardService/${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Connect-Protocol-Version": "1",
    },
    body: JSON.stringify(body ?? {}),
  });

  if (res.status === 401 && opts.retryOn401 !== false) {
    cachedToken = null;
    return callDashboard<T>(endpoint, body, { retryOn401: false });
  }
  if (!res.ok) {
    throw new Error(`${endpoint} returned HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

interface RawCurrentPeriod {
  billingCycleStart?: string;
  billingCycleEnd?: string;
  planUsage?: {
    totalSpend?: number;
    includedSpend?: number;
    bonusSpend?: number;
    limit?: number;
    remaining?: number;
    remainingBonus?: boolean;
    autoPercentUsed?: number;
    apiPercentUsed?: number;
    totalPercentUsed?: number;
  };
  spendLimitUsage?: {
    individualLimit?: number;
    individualUsed?: number;
    individualRemaining?: number;
    pooledLimit?: number;
    pooledUsed?: number;
    pooledRemaining?: number;
    limitType?: string;
  };
  displayMessage?: string;
}

interface RawPlanInfo {
  planInfo?: {
    planName?: string;
    includedAmountCents?: number;
    price?: string;
    billingCycleEnd?: string;
  };
}

export interface CursorUsage {
  status: "ok";
  plan: { name: string; price: string | null; includedCents: number };
  cycle: { startMs: number | null; endMs: number };
  /** Cents — split into included (counts against limit) and bonus (free credits). */
  spend: {
    totalCents: number;
    includedCents: number;
    bonusCents: number;
    remainingCents: number;
    percentUsed: number;
  };
  /** On-demand budget after plan exhausted. `null` when no limit set. */
  overage: { individualLimitCents: number | null; individualUsedCents: number | null };
  displayMessage: string | null;
  fetchedAt: number;
}

export interface CursorUsageError {
  status: "unavailable";
  reason: string;
  dashboardUrl: string;
  fetchedAt: number;
}

export type CursorUsageResult = CursorUsage | CursorUsageError;

let lastResult: { value: CursorUsageResult; expiresAt: number } | null = null;

export async function getCursorUsage(force = false): Promise<CursorUsageResult> {
  const now = Date.now();
  if (!force && lastResult && lastResult.expiresAt > now) {
    return lastResult.value;
  }
  const fetchedAt = now;
  try {
    const [usage, plan] = await Promise.all([
      callDashboard<RawCurrentPeriod>("GetCurrentPeriodUsage", {}),
      callDashboard<RawPlanInfo>("GetPlanInfo", {}),
    ]);
    const pu = usage.planUsage ?? {};
    const includedCents = pu.includedSpend ?? 0;
    const bonusCents = pu.bonusSpend ?? 0;
    const totalCents = pu.totalSpend ?? includedCents + bonusCents;
    const limitCents = pu.limit ?? plan.planInfo?.includedAmountCents ?? 0;
    const remainingCents =
      pu.remaining !== undefined
        ? pu.remaining
        : Math.max(0, limitCents - includedCents);
    const percentUsed =
      pu.totalPercentUsed !== undefined && Number.isFinite(pu.totalPercentUsed)
        ? pu.totalPercentUsed
        : limitCents > 0
          ? (includedCents / limitCents) * 100
          : 0;
    const cycleEndStr = usage.billingCycleEnd ?? plan.planInfo?.billingCycleEnd ?? "0";
    const cycleStartStr = usage.billingCycleStart ?? null;

    const result: CursorUsage = {
      status: "ok",
      plan: {
        name: plan.planInfo?.planName ?? "Cursor",
        price: plan.planInfo?.price ?? null,
        includedCents: limitCents,
      },
      cycle: {
        startMs: cycleStartStr ? Number(cycleStartStr) : null,
        endMs: Number(cycleEndStr) || 0,
      },
      spend: {
        totalCents,
        includedCents,
        bonusCents,
        remainingCents,
        percentUsed,
      },
      overage: {
        individualLimitCents: usage.spendLimitUsage?.individualLimit ?? null,
        individualUsedCents: usage.spendLimitUsage?.individualUsed ?? null,
      },
      displayMessage: usage.displayMessage ?? null,
      fetchedAt,
    };
    lastResult = { value: result, expiresAt: now + CACHE_TTL_MS };
    return result;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const result: CursorUsageError = {
      status: "unavailable",
      reason,
      dashboardUrl: "https://cursor.com/dashboard",
      fetchedAt,
    };
    // Cache failures briefly too, so a misconfigured deploy doesn't
    // hammer Auth0 from the UI's poll loop.
    lastResult = { value: result, expiresAt: now + 60_000 };
    return result;
  }
}
