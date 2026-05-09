#!/usr/bin/env bash
#
# Native dev launcher for icarus-server.
#
# Why this exists:
#   The dockerized server can't reach LAN peers (e.g. a Jetson box
#   on your home subnet running the voice STT/TTS services). Docker
#   Desktop on macOS routes container traffic through a virtualized
#   Linux VM whose gvisor NAT only forwards internet traffic — LAN
#   peers on the Mac's physical subnet are unreachable. "Enable host
#   networking" only shares the VM's namespace (still NAT'd), not
#   the Mac's. (Linux hosts don't have this problem; Docker on Linux
#   shares the host network namespace directly.)
#
#   Running the server natively bypasses all of that. The Node
#   process binds to the Mac's loopback at port 4000, has full
#   LAN access, and the dockerized `app` container's browser bundle
#   already points at `http://localhost:4000` so nothing else
#   changes. `docker compose stop server` first to free the port.
#
# Usage:
#   docker compose stop server
#   ./scripts/dev-native.sh

set -e
set -o pipefail

cd "$(dirname "$0")/.."

# Load ../.env into the environment if present. `set -a` exports
# every assignment automatically — same shape as docker-compose's
# env-file loader, no dotenv dep needed.
if [ -f ../.env ]; then
  set -a
  # shellcheck disable=SC1091
  . ../.env
  set +a
fi

# Native-only defaults. These overrides handle the Docker-vs-native
# path differences (Docker bind-mounts /workspace and /app/store;
# native uses host paths directly).
export WORKSPACE_ROOT="${WORKSPACE_ROOT:-${WORKSPACE_DIR:-$HOME/work}}"
export ICARUS_DATA="${ICARUS_DATA:-$(pwd)/../store}"
export CURSOR_DESKTOP_PATH="${CURSOR_DESKTOP_PATH:-$HOME/Library/Application Support/Cursor/User/globalStorage/state.vscdb}"
export PORT="${PORT:-4000}"

# Cursor CLI installer drops binaries here; many shells omit ~/.local/bin → ENOENT on POST /chats.
if [ -x "${HOME}/.local/bin/cursor-agent" ]; then
  export PATH="${HOME}/.local/bin:${PATH}"
fi

if [ -z "${CURSOR_API_KEY:-}" ]; then
  echo "ERROR: CURSOR_API_KEY not set (looked in env and ../.env)" >&2
  exit 1
fi

echo "icarus-server (native) starting…"
echo "  PORT=$PORT"
echo "  WORKSPACE_ROOT=$WORKSPACE_ROOT"
echo "  ICARUS_DATA=$ICARUS_DATA"
echo "  VOICE_STT_URL=${VOICE_STT_URL:-<unset>}"
echo "  VOICE_TTS_URL=${VOICE_TTS_URL:-<unset>}"
echo "  VOICE_TTS_VOICE=${VOICE_TTS_VOICE:-default}"

exec npm run dev
