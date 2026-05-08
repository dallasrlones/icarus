import type { NextFunction, Request, Response } from "express";
import { verifyToken, type JwtClaims } from "./jwt.js";
import { getUserById, type PublicUser } from "./service.js";

declare module "express-serve-static-core" {
  interface Request {
    auth?: { claims: JwtClaims; user: PublicUser };
  }
}

/**
 * Routes that bypass auth entirely. Keep this list TINY — every entry
 * here is a public endpoint. We intentionally don't whitelist `/health`
 * by prefix to avoid accidentally exposing future `/health/*` routes.
 */
const PUBLIC_PATHS = new Set<string>([
  "/health",
  "/v1/auth/login",
]);

function bearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (typeof header === "string" && header.toLowerCase().startsWith("bearer ")) {
    return header.slice(7).trim();
  }
  // SSE/EventSource clients can't easily set Authorization headers,
  // so we accept `?access_token=` as a fallback for those flows.
  const q = req.query?.access_token;
  if (typeof q === "string" && q.length > 0) return q;
  return null;
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (PUBLIC_PATHS.has(req.path)) return next();

  const token = bearerToken(req);
  if (!token) {
    res.status(401).json({ error: "missing token", code: "missing_token" });
    return;
  }

  const claims = verifyToken(token);
  if (!claims) {
    res.status(401).json({ error: "invalid or expired token", code: "invalid_token" });
    return;
  }

  const user = await getUserById(claims.sub);
  if (!user) {
    res.status(401).json({ error: "user no longer exists", code: "user_missing" });
    return;
  }

  req.auth = { claims, user };
  next();
}

/**
 * Allowlist of paths a user with `must_change_password` may still
 * touch. Anything else 403s with `must_change_password: true` so the
 * client can route to the change-password screen.
 */
const PASSWORD_CHANGE_BYPASS = new Set<string>([
  "/v1/auth/me",
  "/v1/auth/logout",
  "/v1/auth/change-password",
]);

export function requireMutablePassword(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (PUBLIC_PATHS.has(req.path)) return next();
  if (!req.auth?.user.must_change_password) return next();
  if (PASSWORD_CHANGE_BYPASS.has(req.path)) return next();

  res.status(403).json({
    error: "password change required",
    code: "must_change_password",
    must_change_password: true,
  });
}
