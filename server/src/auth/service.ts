import { getUserModel, type UserRow } from "./db.js";
import { hashPassword, verifyPassword, validatePasswordPolicy } from "./passwords.js";

export interface PublicUser {
  id: string;
  username: string;
  must_change_password: boolean;
  last_login_at: string | null;
  created_at?: string;
  updated_at?: string;
}

export class AuthError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const BOOTSTRAP_USERNAME = process.env.AUTH_BOOTSTRAP_USERNAME ?? "admin";
const BOOTSTRAP_PASSWORD = process.env.AUTH_BOOTSTRAP_PASSWORD ?? "changeme";

function publicUser(row: UserRow & { id: string; created_at?: string; updated_at?: string }): PublicUser {
  return {
    id: row.id,
    username: row.username,
    must_change_password: Boolean(row.must_change_password),
    last_login_at: row.last_login_at ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Seed the default admin user the first time the server boots against
 * an empty users table. Idempotent — subsequent calls are no-ops once
 * a user exists. The default credentials are intentionally weak
 * (`admin` / `changeme`) so the very first sign-in flips
 * `must_change_password` and forces a real password.
 */
export async function ensureBootstrapAdmin(): Promise<void> {
  const User = getUserModel();
  // Two-stage check: prefer the username-keyed lookup (the column is
  // unique-indexed) and fall back to a "any users at all?" sweep so a
  // renamed admin doesn't get a duplicate seed. `count({})` proved
  // unreliable across aerekos-record versions for soft-deleted /
  // timestamped models, so we use `findAll({ limit: 1 })` instead.
  const existing = await User.findBy({ username: BOOTSTRAP_USERNAME });
  if (existing) return;
  const anyUsers = await User.findAll({ limit: 1 });
  if (anyUsers.length > 0) return;
  const hash = await hashPassword(BOOTSTRAP_PASSWORD);
  await User.create({
    username: BOOTSTRAP_USERNAME,
    password: hash,
    must_change_password: true,
    last_login_at: null,
  });
  console.log(
    `[auth] bootstrap admin created (username='${BOOTSTRAP_USERNAME}', ` +
      `password='${BOOTSTRAP_PASSWORD}'). Change it on first sign-in.`,
  );
}

export interface LoginResult {
  user: PublicUser;
}

export async function loginUser(username: string, password: string): Promise<LoginResult> {
  if (typeof username !== "string" || typeof password !== "string") {
    throw new AuthError(400, "bad_request", "username and password are required");
  }
  const User = getUserModel();
  const row = await User.findBy({ username: username.trim() });
  if (!row) throw new AuthError(401, "invalid_credentials", "invalid credentials");

  const ok = await verifyPassword(password, row.password);
  if (!ok) throw new AuthError(401, "invalid_credentials", "invalid credentials");

  const now = new Date().toISOString();
  await User.update(row.id, { last_login_at: now });
  return { user: publicUser({ ...row, last_login_at: now }) };
}

export async function getUserById(id: string): Promise<PublicUser | null> {
  const User = getUserModel();
  const row = await User.find(id);
  if (!row) return null;
  return publicUser(row);
}

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<PublicUser> {
  const policy = validatePasswordPolicy(newPassword);
  if (!policy.ok) throw new AuthError(400, "weak_password", policy.reason);

  const User = getUserModel();
  const row = await User.find(userId);
  if (!row) throw new AuthError(404, "not_found", "user not found");

  const ok = await verifyPassword(currentPassword, row.password);
  if (!ok) throw new AuthError(401, "invalid_credentials", "current password is incorrect");

  if (await verifyPassword(newPassword, row.password)) {
    throw new AuthError(400, "password_unchanged", "new password must differ from current password");
  }

  const hash = await hashPassword(newPassword);
  const updated = await User.update(userId, {
    password: hash,
    must_change_password: false,
  });
  return publicUser(updated);
}
