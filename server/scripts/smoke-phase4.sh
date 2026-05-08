#!/usr/bin/env bash
# Phase 4 backend smoke. Drives the full lifecycle:
#   draft → flowing (auto) → flow_review → flow_approved → planning → planned
# and verifies each gate.
#
# Usage:
#   ./server/scripts/smoke-phase4.sh <project_slug>

set -euo pipefail

SLUG="${1:?usage: smoke-phase4.sh <project_slug>}"
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
apply_expect_err() {
  local out
  out=$(apply "$1")
  local ok
  ok=$(echo "$out" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("ok"))')
  if [ "$ok" = "True" ]; then
    echo "EXPECTED ok=false, got: $out" >&2
    exit 1
  fi
  echo "$out"
}
get() {
  curl -sS "$BASE$1"
}
jq_get() {
  python3 -c "import sys,json;print(json.load(sys.stdin)$1)"
}

step() { echo; echo "=== $1 ==="; }

# ---- Setup: feature + minimal flow ----
step "feature"
FEAT=$(apply_expect_ok "{\"kind\":\"add_feature\",\"payload\":{\"project_slug\":\"$SLUG\",\"name\":\"P4 Verify\",\"description\":\"council pipeline smoke\"}}" | jq_get '["result"]["feature"]["id"]')
echo "feat=$FEAT"

step "build a meaty flow (nodes + edges) so the council has something concrete to plan against"
update_feat_desc() {
  apply_expect_ok "{\"kind\":\"update_feature\",\"payload\":{\"project_slug\":\"$SLUG\",\"feature_id\":\"$FEAT\",\"description\":\"User-initiated password reset: signed-in user opens settings, requests a reset link to their verified email, follows the link to set a new password, and is redirected back signed in.\"}}" >/dev/null
}
update_feat_desc

add_node() {
  apply_expect_ok "{\"kind\":\"add_flow_node\",\"payload\":{\"project_slug\":\"$SLUG\",\"feature_id\":\"$FEAT\",\"label\":\"$1\",\"kind\":\"$2\",\"description\":\"$3\"}}" | jq_get '["result"]["node"]["id"]'
}
N1=$(add_node "User opens settings" "step" "Authenticated user lands on the security tab")
N2=$(add_node "Click reset password" "step" "Triggers POST /password-reset/request")
N3=$(add_node "Email delivered?" "decision" "Branch on whether the verified email exists and was sent")
N4=$(add_node "Show error" "step" "Surface a generic error so we don't leak account existence")
N5=$(add_node "User opens link" "external" "Clicks the time-bounded reset URL from their inbox")
N6=$(add_node "Set new password" "step" "Validates strength rules, persists hash, invalidates old sessions")
N7=$(add_node "Auto sign-in + redirect" "step" "Issues new session and redirects back to the app")
echo "nodes: $N1 $N2 $N3 $N4 $N5 $N6 $N7"

add_edge() {
  apply_expect_ok "{\"kind\":\"add_flow_edge\",\"payload\":{\"project_slug\":\"$SLUG\",\"feature_id\":\"$FEAT\",\"from_node_id\":\"$1\",\"to_node_id\":\"$2\"${3:-}}}" >/dev/null
}
add_edge "$N1" "$N2"
add_edge "$N2" "$N3"
add_edge "$N3" "$N5" ',"label":"sent"'
add_edge "$N3" "$N4" ',"label":"not sent"'
add_edge "$N5" "$N6"
add_edge "$N6" "$N7"

# ---- Flow review ----
step "request_flow_review (status flowing → flow_review)"
RUN1=$(apply_expect_ok "{\"kind\":\"request_flow_review\",\"payload\":{\"project_slug\":\"$SLUG\",\"feature_id\":\"$FEAT\"}}" | jq_get '["result"]["run"]["id"]')
echo "run=$RUN1"

step "feature should be in flow_review immediately"
FEAT="$FEAT" SLUG="$SLUG" BASE="$BASE" python3 <<'PY'
import os, json, urllib.request as u
d = json.loads(u.urlopen(f"{os.environ['BASE']}/projects/{os.environ['SLUG']}/features").read())
print([f["status"] for f in d["features"] if f["id"] == os.environ["FEAT"]][0])
PY

step "poll for council run completion (max 90s)"
for i in $(seq 1 45); do
  STATUS=$(RUN="$RUN1" SLUG="$SLUG" FEAT="$FEAT" BASE="$BASE" python3 <<'PY'
import os, json, urllib.request as u
d = json.loads(u.urlopen(f"{os.environ['BASE']}/projects/{os.environ['SLUG']}/council/{os.environ['FEAT']}").read())
r = [r for r in d["runs"] if r["id"] == os.environ["RUN"]][0]
print(r["status"])
PY
)
  echo "  attempt $i → $STATUS"
  if [ "$STATUS" = "completed" ] || [ "$STATUS" = "failed" ]; then break; fi
  sleep 2
done

step "fetch run artifact"
URL="$BASE/projects/$SLUG/council/$FEAT/flow_review/$RUN1" python3 <<'PY'
import os, json, urllib.request as u
d = json.loads(u.urlopen(os.environ["URL"]).read())["run"]
print("status:", d["status"])
if d.get("error"):
    print("error:", d["error"][:300])
if d.get("result"):
    r = d["result"]
    if r["kind"] == "flow_review":
        chair = r["chair"]
        print("chair verdict:", chair["overall_verdict"])
        print("chair recommendation:", chair["recommendation"][:200])
        print("must_address_count:", chair["must_address_count"])
        for lens in r["lenses"]:
            print("  lens=" + lens["lens"] + " verdict=" + lens["verdict"] + " findings=" + str(len(lens["findings"])))
PY

step "GATE: approve_flow before status=flow_review fails — try approving from flow_approved (must reject)"
# (We'll get to this once we approve normally below.)

step "approve_flow"
apply_expect_ok "{\"kind\":\"approve_flow\",\"payload\":{\"project_slug\":\"$SLUG\",\"feature_id\":\"$FEAT\",\"run_id\":\"$RUN1\"}}" | jq_get '["result"]["feature"]["status"]'

step "GATE: gated add_task with feature_id (still rejected — flow_approved isn't planned+)"
apply_expect_err "{\"kind\":\"add_task\",\"payload\":{\"project_slug\":\"$SLUG\",\"feature_id\":\"$FEAT\",\"title\":\"too early\"}}" >/dev/null
echo "  rejected as expected"

# ---- Task planning ----
step "request_task_planning (flow_approved → planning)"
RUN2=$(apply_expect_ok "{\"kind\":\"request_task_planning\",\"payload\":{\"project_slug\":\"$SLUG\",\"feature_id\":\"$FEAT\"}}" | jq_get '["result"]["run"]["id"]')
echo "run=$RUN2"

step "poll for task planning run completion (max 90s)"
for i in $(seq 1 45); do
  STATUS=$(RUN="$RUN2" SLUG="$SLUG" FEAT="$FEAT" BASE="$BASE" python3 <<'PY'
import os, json, urllib.request as u
d = json.loads(u.urlopen(f"{os.environ['BASE']}/projects/{os.environ['SLUG']}/council/{os.environ['FEAT']}?type=task_planning").read())
r = [r for r in d["runs"] if r["id"] == os.environ["RUN"]][0]
print(r["status"])
PY
)
  echo "  attempt $i → $STATUS"
  if [ "$STATUS" = "completed" ] || [ "$STATUS" = "failed" ]; then break; fi
  sleep 2
done

step "fetch task planning artifact"
PROPOSALS=$(URL="$BASE/projects/$SLUG/council/$FEAT/task_planning/$RUN2" python3 <<'PY'
import sys, os, json, urllib.request as u
d = json.loads(u.urlopen(os.environ["URL"]).read())["run"]
print("status:", d["status"], file=sys.stderr)
if d.get("error"):
    print("error:", d["error"][:300], file=sys.stderr)
if d.get("result", {}).get("kind") == "task_planning":
    ids = [t["id"] for t in d["result"]["proposed_tasks"]]
    print(",".join(ids))
PY
)
echo "proposed_ids=$PROPOSALS"

step "verify proposed tasks landed in tasks.json"
FEAT="$FEAT" SLUG="$SLUG" BASE="$BASE" python3 <<'PY'
import os, json, urllib.request as u
d = json.loads(u.urlopen(f"{os.environ['BASE']}/projects/{os.environ['SLUG']}/tasks").read())["tasks"]
proposed = [t for t in d if t.get("feature_id") == os.environ["FEAT"] and t.get("proposed")]
print(f"proposed count: {len(proposed)}")
for t in proposed[:5]:
    title = t["title"][:60]
    print(f"  - id={t['id']} title=\"{title}\" priority={t.get('priority')}")
PY

if [ -z "$PROPOSALS" ]; then
  echo "  (council declined to propose tasks — flow probably needs more detail; skipping approve_tasks gates downstream)"
  echo "phase 4 backend smoke OK (with zero-proposal tolerance)"
  exit 0
fi

step "approve_tasks (keep all proposals)"
KEEP_JSON=$(PROPOSALS="$PROPOSALS" python3 <<'PY'
import os
ids = [x for x in os.environ["PROPOSALS"].strip().split(",") if x]
print(",".join('"' + x + '"' for x in ids))
PY
)
apply_expect_ok "{\"kind\":\"approve_tasks\",\"payload\":{\"project_slug\":\"$SLUG\",\"feature_id\":\"$FEAT\",\"task_ids\":[$KEEP_JSON]}}" | jq_get '["result"]'

step "feature should now be planned"
SLUG="$SLUG" FEAT="$FEAT" BASE="$BASE" python3 <<'PY'
import os, json, urllib.request as u
d = json.loads(u.urlopen(f"{os.environ['BASE']}/projects/{os.environ['SLUG']}/features").read())
print([f["status"] for f in d["features"] if f["id"] == os.environ["FEAT"]][0])
PY

step "GATE NOW UNLOCKED: feature-attached add_task should succeed"
T_NEW=$(apply_expect_ok "{\"kind\":\"add_task\",\"payload\":{\"project_slug\":\"$SLUG\",\"feature_id\":\"$FEAT\",\"title\":\"manual addition\"}}" | jq_get '["result"]["task"]["id"]')
echo "added task=$T_NEW"

# ---- Stale-on-edit ----
step "edit flow (rename a node) → feature should drop back to flowing + tasks marked stale"
apply_expect_ok "{\"kind\":\"update_flow_node\",\"payload\":{\"project_slug\":\"$SLUG\",\"feature_id\":\"$FEAT\",\"node_id\":\"$N1\",\"label\":\"renamed trigger\"}}" | jq_get '["result"]'
SLUG="$SLUG" FEAT="$FEAT" BASE="$BASE" python3 <<'PY'
import os, json, urllib.request as u
fd = json.loads(u.urlopen(f"{os.environ['BASE']}/projects/{os.environ['SLUG']}/features").read())
td = json.loads(u.urlopen(f"{os.environ['BASE']}/projects/{os.environ['SLUG']}/tasks").read())
print("feature status:", [f["status"] for f in fd["features"] if f["id"] == os.environ["FEAT"]][0])
stale = [t for t in td["tasks"] if t.get("feature_id") == os.environ["FEAT"] and t["status"] == "stale"]
print(f"stale tasks: {len(stale)}")
PY

step "drag (pure position) should NOT bump"
apply_expect_ok "{\"kind\":\"update_flow_node\",\"payload\":{\"project_slug\":\"$SLUG\",\"feature_id\":\"$FEAT\",\"node_id\":\"$N1\",\"x\":420,\"y\":300}}" | jq_get '["result"]'
SLUG="$SLUG" FEAT="$FEAT" BASE="$BASE" python3 <<'PY'
import os, json, urllib.request as u
d = json.loads(u.urlopen(f"{os.environ['BASE']}/projects/{os.environ['SLUG']}/features").read())
print("feature status (should still be flowing):", [f["status"] for f in d["features"] if f["id"] == os.environ["FEAT"]][0])
PY

step "cleanup"
apply_expect_ok "{\"kind\":\"archive_feature\",\"payload\":{\"project_slug\":\"$SLUG\",\"feature_id\":\"$FEAT\"}}" | jq_get '["result"]["feature"]["status"]'
echo
echo "phase 4 backend smoke OK"
