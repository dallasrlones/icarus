#!/usr/bin/env bash
#
# Build a tiny Cursor `state.vscdb` containing only the rows icarus needs for
# `/v1/cursor/usage` (JWT + membership hints). The real desktop file is often
# gigabytes — copying it to a LAN server or bind-mounting it into Docker is
# impractical; this extract is typically ~12 KiB.
#
# Usage (macOS default source path):
#   ./server/scripts/export-cursor-desktop-auth-for-usage.sh \
#     ./.cursor-ro-stub/User/globalStorage/state.vscdb
#
# Then point compose at the parent dir, e.g. in `.env`:
#   CURSOR_DESKTOP_HOST_DIR=/absolute/path/to/repo/.cursor-ro-stub
#
# Env overrides:
#   CURSOR_DESKTOP_DB_SOURCE — path to the full desktop state.vscdb

set -euo pipefail

SRC="${CURSOR_DESKTOP_DB_SOURCE:-$HOME/Library/Application Support/Cursor/User/globalStorage/state.vscdb}"
DEST="${1:-}"

if [[ -z "$DEST" ]]; then
  echo "usage: $0 <path-to-output-state.vscdb>" >&2
  echo "example: $0 ./.cursor-ro-stub/User/globalStorage/state.vscdb" >&2
  exit 1
fi

if [[ ! -f "$SRC" ]]; then
  echo "error: source DB not found: $SRC" >&2
  exit 1
fi

mkdir -p "$(dirname "$DEST")"
tmp="$(mktemp "${TMPDIR:-/tmp}/icarus-cursor-auth.XXXXXX.vscdb")"
cleanup() {
  rm -f "$tmp"
}
trap cleanup EXIT

sqlite3 "$tmp" 'CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);'

sqlite3 "$SRC" <<SQL
ATTACH '${tmp}' AS stub;
INSERT INTO stub.ItemTable SELECT key, value FROM ItemTable WHERE key IN ('cursorAuth/accessToken','cursorAuth/refreshToken','cursorAuth/stripeMembershipType');
DETACH stub;
SQL
cp "$tmp" "$DEST"
bytes="$(wc -c <"$DEST" | tr -d ' ')"
echo "wrote $DEST (${bytes} bytes)"
