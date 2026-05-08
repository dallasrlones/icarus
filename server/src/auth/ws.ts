import type { IncomingMessage } from "node:http";
import { verifyToken, type JwtClaims } from "./jwt.js";

/**
 * Browsers can't set custom headers on `new WebSocket(...)`, so the
 * client passes the JWT as a `?token=` query param at upgrade time.
 * We validate before the WS handshake completes; bad/missing tokens
 * are rejected with `401 Unauthorized` and the socket never opens.
 */
export function authenticateUpgrade(req: IncomingMessage): JwtClaims | null {
  try {
    const url = new URL(req.url ?? "", "http://localhost");
    const token = url.searchParams.get("token") ?? url.searchParams.get("access_token");
    if (!token) return null;
    return verifyToken(token);
  } catch {
    return null;
  }
}
