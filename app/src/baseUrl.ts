/**
 * Tiny shared module for the icarus-server base URL.
 *
 * Lives here (not in `api.ts`) so `auth.ts` can resolve it without
 * forming a require cycle (`api.ts` imports `authFetch` from
 * `auth.ts`, and `auth.ts` needs the base URL to reach the
 * `/v1/auth/*` endpoints — both modules now depend on this leaf
 * module instead of on each other).
 */

const FALLBACK_API = "http://localhost:4000";

export function apiBaseUrl(): string {
  const fromEnv = process.env.EXPO_PUBLIC_API_URL;
  if (fromEnv && fromEnv.length > 0) return fromEnv.replace(/\/$/, "");
  if (typeof window !== "undefined" && window.location?.hostname) {
    return `${window.location.protocol}//${window.location.hostname}:4000`;
  }
  return FALLBACK_API;
}
