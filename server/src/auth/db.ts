import path from "node:path";
import fs from "node:fs";
import Record, { type Database, type Model } from "aerekos-record";
import { dataRoot } from "../storage/paths.js";

/**
 * User record shape. `password` stores a bcrypt hash (we don't use
 * aerekos-record's `encrypted` type because it's omitted from reads
 * and we need the hash to verify on login). `must_change_password`
 * forces the change-password flow on first sign-in (and any future
 * admin-driven password reset).
 */
export interface UserRow extends Record<string, unknown> {
  username: string;
  password: string;
  must_change_password: boolean;
  last_login_at: string | null;
}

export type UserModel = Model<UserRow>;

let dbHandle: Database | null = null;
let userModel: UserModel | null = null;

function authDbPath(): string {
  if (process.env.AUTH_DB_PATH) return path.resolve(process.env.AUTH_DB_PATH);
  return path.join(dataRoot(), "auth.sqlite");
}

function ensureParentDir(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

export function getAuthDb(): Database {
  if (dbHandle) return dbHandle;
  const file = authDbPath();
  ensureParentDir(file);
  dbHandle = Record.connect("sqlite", { database: file });
  return dbHandle;
}

export function getUserModel(): UserModel {
  if (userModel) return userModel;
  userModel = getAuthDb().model<UserRow>(
    "User",
    {
      username: "string",
      password: "string",
      must_change_password: "boolean",
      last_login_at: "string",
    },
    {
      required: ["username", "password"],
      unique: ["username"],
      indexes: ["username"],
      timestamps: true,
    },
  );
  return userModel;
}

export async function closeAuthDb(): Promise<void> {
  if (!dbHandle) return;
  await dbHandle.close();
  dbHandle = null;
  userModel = null;
}
