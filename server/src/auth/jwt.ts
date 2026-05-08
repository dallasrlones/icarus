import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { dataRoot } from "../storage/paths.js";

const DEFAULT_EXPIRES_IN = process.env.JWT_EXPIRES_IN ?? "7d";

export interface JwtClaims {
  sub: string;
  username: string;
  must_change_password: boolean;
}

let cachedSecret: string | null = null;

function secretFile(): string {
  if (process.env.JWT_SECRET_FILE) return path.resolve(process.env.JWT_SECRET_FILE);
  return path.join(dataRoot(), ".jwt-secret");
}

/**
 * Resolve the JWT signing key. Precedence:
 *   1. `JWT_SECRET` env var  (operator-managed; rotate by changing env)
 *   2. `<dataRoot>/.jwt-secret` file (auto-generated on first boot;
 *      gitignored via the `store/` rule)
 *
 * The file path can be overridden with `JWT_SECRET_FILE`. Generating
 * lazily means a fresh checkout doesn't need any setup ritual — just
 * `npm start` and the secret materialises locally.
 */
export function loadJwtSecret(): string {
  if (cachedSecret) return cachedSecret;

  const fromEnv = process.env.JWT_SECRET;
  if (fromEnv && fromEnv.trim().length >= 16) {
    cachedSecret = fromEnv.trim();
    return cachedSecret;
  }

  const file = secretFile();
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing.length >= 32) {
      cachedSecret = existing;
      return cachedSecret;
    }
  } catch {
    // file missing — fall through and create one
  }

  const generated = crypto.randomBytes(48).toString("base64url");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, generated, { mode: 0o600 });
  cachedSecret = generated;
  return cachedSecret;
}

export function signToken(claims: JwtClaims, opts: { expiresIn?: string } = {}): string {
  const secret = loadJwtSecret();
  return jwt.sign(claims, secret, {
    expiresIn: (opts.expiresIn ?? DEFAULT_EXPIRES_IN) as jwt.SignOptions["expiresIn"],
    algorithm: "HS256",
  });
}

export function verifyToken(token: string): JwtClaims | null {
  if (!token) return null;
  try {
    const decoded = jwt.verify(token, loadJwtSecret(), { algorithms: ["HS256"] });
    if (typeof decoded !== "object" || decoded === null) return null;
    const obj = decoded as Record<string, unknown>;
    if (typeof obj.sub !== "string" || typeof obj.username !== "string") return null;
    return {
      sub: obj.sub,
      username: obj.username,
      must_change_password: Boolean(obj.must_change_password),
    };
  } catch {
    return null;
  }
}
