import bcrypt from "bcryptjs";

const ROUNDS = Number(process.env.AUTH_BCRYPT_ROUNDS ?? 10);

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, ROUNDS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  if (!hash) return false;
  try {
    return await bcrypt.compare(plain, hash);
  } catch {
    return false;
  }
}

/**
 * Cheap but defensible policy for self-hosted single-user deploys —
 * keep humans from typing `1` as a "new" password but stop short of
 * NIST-style complexity rules nobody follows.
 */
export function validatePasswordPolicy(plain: string): { ok: true } | { ok: false; reason: string } {
  if (typeof plain !== "string") return { ok: false, reason: "password must be a string" };
  if (plain.length < 8) return { ok: false, reason: "password must be at least 8 characters" };
  if (plain.length > 256) return { ok: false, reason: "password must be 256 characters or fewer" };
  if (plain.trim() !== plain) return { ok: false, reason: "password cannot start or end with whitespace" };
  return { ok: true };
}
