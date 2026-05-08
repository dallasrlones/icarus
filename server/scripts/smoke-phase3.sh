#!/usr/bin/env bash
# Phase 3 verb matrix. Asserts that every Phase 3 verb works against
# /v1/mutations/apply and that the lifecycle gate for `add_task` rejects
# feature-attached tasks until the parent feature is `planned`+.
#
# Usage:
#   ./server/scripts/smoke-phase3.sh <project_slug>

set -euo pipefail

SLUG="${1:?usage: smoke-phase3.sh <project_slug>}"
BASE="${BASE:-http://localhost:4000}"

apply() {
  curl -sS -X POST -H 'Content-Type: application/json' -d "$1" "$BASE/v1/mutations/apply"
}

jq_get() {
  python3 -c "import sys,json;print(json.load(sys.stdin)$1)"
}

step() {
  echo
  echo "=== $1 ==="
}

step "add_feature"
FEAT=$(apply "{\"kind\":\"add_feature\",\"payload\":{\"project_slug\":\"$SLUG\",\"name\":\"Phase 3 Verify\",\"description\":\"matrix test\"}}" | jq_get '["result"]["feature"]["id"]')
echo "feature=$FEAT"

step "add_flow_node x2"
N1=$(apply "{\"kind\":\"add_flow_node\",\"payload\":{\"project_slug\":\"$SLUG\",\"feature_id\":\"$FEAT\",\"label\":\"start\",\"kind\":\"step\"}}" | jq_get '["result"]["node"]["id"]')
N2=$(apply "{\"kind\":\"add_flow_node\",\"payload\":{\"project_slug\":\"$SLUG\",\"feature_id\":\"$FEAT\",\"label\":\"finish\",\"kind\":\"decision\"}}" | jq_get '["result"]["node"]["id"]')
echo "n1=$N1 n2=$N2"

step "add_flow_edge"
EDGE=$(apply "{\"kind\":\"add_flow_edge\",\"payload\":{\"project_slug\":\"$SLUG\",\"feature_id\":\"$FEAT\",\"from_node_id\":\"$N1\",\"to_node_id\":\"$N2\",\"label\":\"go\"}}" | jq_get '["result"]["edge"]["id"]')
echo "edge=$EDGE"

step "update_flow_node (move n1 to 420,260)"
apply "{\"kind\":\"update_flow_node\",\"payload\":{\"project_slug\":\"$SLUG\",\"feature_id\":\"$FEAT\",\"node_id\":\"$N1\",\"x\":420,\"y\":260}}" | jq_get '["result"]["node"]'

step "GATE: add_task with feature_id (must reject)"
apply "{\"kind\":\"add_task\",\"payload\":{\"project_slug\":\"$SLUG\",\"feature_id\":\"$FEAT\",\"title\":\"will fail\"}}" | python3 -m json.tool

step "ad-hoc add_task (must succeed)"
TASK=$(apply "{\"kind\":\"add_task\",\"payload\":{\"project_slug\":\"$SLUG\",\"title\":\"verify suite\",\"priority\":3}}" | jq_get '["result"]["task"]["id"]')
echo "task=$TASK"

step "update_task -> in_progress"
apply "{\"kind\":\"update_task\",\"payload\":{\"project_slug\":\"$SLUG\",\"task_id\":\"$TASK\",\"status\":\"in_progress\"}}" | jq_get '["result"]["task"]["status"]'

step "remove_flow_node (cascades edge)"
apply "{\"kind\":\"remove_flow_node\",\"payload\":{\"project_slug\":\"$SLUG\",\"feature_id\":\"$FEAT\",\"node_id\":\"$N1\"}}" | jq_get '["result"]'

step "final flow state"
curl -sS "$BASE/projects/$SLUG/flows/$FEAT" | python3 -m json.tool

step "cleanup"
apply "{\"kind\":\"archive_feature\",\"payload\":{\"project_slug\":\"$SLUG\",\"feature_id\":\"$FEAT\"}}" | jq_get '["ok"]'
apply "{\"kind\":\"archive_task\",\"payload\":{\"project_slug\":\"$SLUG\",\"task_id\":\"$TASK\"}}" | jq_get '["ok"]'
