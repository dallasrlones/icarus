#!/usr/bin/env node
/**
 * Cross-platform (macOS / Linux / Windows): build a tiny state.vscdb with only
 * the ItemTable rows icarus needs for `/v1/cursor/usage`. Avoids copying the
 * multi-GB desktop SQLite file to Docker hosts or Jetsons.
 *
 * Usage (from `server/`): npm run export-cursor-auth-stub -- <output-path>
 * Example: npm run export-cursor-auth-stub -- ../.cursor-ro-stub/User/globalStorage/state.vscdb
 *
 * Env: CURSOR_DESKTOP_DB_SOURCE — explicit path to the full desktop state.vscdb
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const KEYS = [
  "cursorAuth/accessToken",
  "cursorAuth/refreshToken",
  "cursorAuth/stripeMembershipType",
];

function candidateSources() {
  const out = [];
  const env = process.env.CURSOR_DESKTOP_DB_SOURCE?.trim();
  if (env) out.push(env);
  out.push(
    join(
      homedir(),
      "Library/Application Support/Cursor/User/globalStorage/state.vscdb",
    ),
  );
  const xdgBase = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  out.push(join(xdgBase, "Cursor/User/globalStorage/state.vscdb"));
  const appData = process.env.APPDATA;
  if (appData) {
    out.push(join(appData, "Cursor", "User", "globalStorage", "state.vscdb"));
  }
  return [...new Set(out)];
}

function findSource() {
  for (const p of candidateSources()) {
    if (existsSync(p)) return p;
  }
  return null;
}

const dest = process.argv[2];
if (!dest?.trim()) {
  console.error(
    "usage: npm run export-cursor-auth-stub -- <path-to-output-state.vscdb>",
  );
  console.error(
    "example: npm run export-cursor-auth-stub -- ../.cursor-ro-stub/User/globalStorage/state.vscdb",
  );
  process.exit(1);
}

const srcPath = findSource();
if (!srcPath) {
  console.error(
    "error: Cursor desktop state.vscdb not found. Install Cursor, sign in once, or set CURSOR_DESKTOP_DB_SOURCE.",
  );
  process.exit(1);
}

mkdirSync(dirname(dest), { recursive: true });

const placeholders = KEYS.map(() => "?").join(",");
const src = new Database(srcPath, { readonly: true });
const rows = src
  .prepare(
    `SELECT key, value FROM ItemTable WHERE key IN (${placeholders})`,
  )
  .all(...KEYS);
src.close();

const stub = new Database(dest);
stub.exec(
  "CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);",
);
const ins = stub.prepare(
  "INSERT INTO ItemTable (key, value) VALUES (@key, @value)",
);
for (const row of rows) {
  ins.run(row);
}
stub.close();

const bytes = statSync(dest).size;
console.error(`wrote ${dest} (${bytes} bytes) from ${srcPath}`);
