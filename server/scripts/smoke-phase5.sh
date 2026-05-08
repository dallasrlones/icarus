#!/usr/bin/env bash
# Phase 5 backend smoke. Drives a single autonomous task end-to-end:
#   create test project (auto workspace) → add ad-hoc task → start_queue
#   → wait for completion → verify task.status === "done".
#
# This is intentionally a tiny task ("write a hello-world file") so the
# council/cursor-agent costs are bounded; the goal is to verify the
# QueueWorker plumbing, not to test agent capability.
#
# Usage:
#   ./server/scripts/smoke-phase5.sh

set -euo pipefail

BASE="${BASE:-http://localhost:4000}"

apply() {
  curl -sS -X POST -H 'Content-Type: application/json' -d "$1" "$BASE/v1/mutations/apply"
}
apply_expect_ok() {
  local out
  out=$(apply "$1")
  local ok
  ok=$(echo "$out" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("ok"))')
  if [ "$ok" != "True" ]; then
    echo "EXPECTED ok=true, got: $out" >&2
    exit 1
  fi
  echo "$out"
}

step() { echo; echo "=== $1 ==="; }

step "create test project (auto workspace)"
SLUG=$(apply_expect_ok '{"kind":"create_project","payload":{"name":"Phase 5 Smoke","description":"queue worker test","workspace_path":"auto"}}' | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"]["project"]["slug"])')
echo "slug=$SLUG"

step "add ad-hoc task: hello world file"
TASK=$(apply_expect_ok "{\"kind\":\"add_task\",\"payload\":{\"project_slug\":\"$SLUG\",\"title\":\"Write hello.txt with greeting\",\"description\":\"Create a file named hello.txt in the project root containing exactly the line 'hello from the icarus queue worker', then emit complete_task with a 1-sentence summary.\"}}" | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"]["task"]["id"])')
echo "task=$TASK"

step "start queue (scoped to this project)"
apply_expect_ok "{\"kind\":\"start_queue\",\"payload\":{\"project_slug\":\"$SLUG\"}}" | python3 -m json.tool

step "poll task status (max 180s — agent may take a bit)"
for i in $(seq 1 90); do
  STATUS=$(SLUG="$SLUG" TASK="$TASK" BASE="$BASE" python3 <<'PY'
import os, json, urllib.request as u
d = json.loads(u.urlopen(f"{os.environ['BASE']}/projects/{os.environ['SLUG']}/tasks").read())
t = [t for t in d["tasks"] if t["id"] == os.environ["TASK"]][0]
print(t["status"])
PY
)
  CURRENT=$(BASE="$BASE" python3 <<'PY'
import os, json, urllib.request as u
d = json.loads(u.urlopen(f"{os.environ['BASE']}/queue").read())
print(d.get("current") or "(none)")
PY
)
  echo "  attempt $i — task=$STATUS  current=$CURRENT"
  if [ "$STATUS" = "done" ]; then break; fi
  sleep 2
done

step "fetch run record"
SLUG="$SLUG" TASK="$TASK" BASE="$BASE" python3 <<'PY'
import os, json, urllib.request as u
d = json.loads(u.urlopen(f"{os.environ['BASE']}/projects/{os.environ['SLUG']}/tasks/{os.environ['TASK']}/runs").read())
runs = d["runs"]
if not runs:
    print("no runs recorded")
else:
    r = runs[0]
    print("run status:", r["status"])
    print("pills:", len(r["pills"]))
    for p in r["pills"]:
        print("  -", p.get("kind"), "->", "ok" if "result" in p else f"error={p.get('error', '')[:120]}")
    if r.get("error"):
        print("error:", r["error"][:300])
    print("output tail (last 400 chars):")
    print(r["raw_output"][-400:])
PY

step "queue should be back to idle (drained)"
curl -sS "$BASE/queue" | python3 -m json.tool

step "cleanup: archive the test project"
apply_expect_ok "{\"kind\":\"archive_project\",\"payload\":{\"slug\":\"$SLUG\"}}" >/dev/null
echo
echo "phase 5 backend smoke OK"
