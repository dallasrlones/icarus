/**
 * Phase 15 — per-tab opaque client id for voice routing.
 *
 * Generated once on first access and held in module scope. Each
 * browser tab / RN instance gets its own; refresh = new id (we
 * don't persist to localStorage on purpose, so the id can't leak
 * across "reset" actions). Used by:
 *   - chat send → server → agent-emitted `navigate` mutations,
 *   - WS `nav_request` listener → only honor events whose
 *     `client_id` matches this one.
 *
 * No security significance — purely a routing key.
 */

let cached: string | null = null;

export function getClientId(): string {
  if (cached) return cached;
  // crypto.randomUUID exists on web and modern RN runtimes; fall
  // back to a low-quality random for ancient environments. The id
  // is not security-sensitive.
  const cryptoObj =
    typeof globalThis !== "undefined"
      ? (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
      : undefined;
  if (cryptoObj && typeof cryptoObj.randomUUID === "function") {
    cached = cryptoObj.randomUUID();
  } else {
    cached = `c_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`;
  }
  return cached;
}
