#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 <frontend_base_url> <backend_api_base_url>"
  echo "Example: $0 https://my-app.vercel.app https://my-api.azurewebsites.net/api/v1"
  exit 1
fi

FRONTEND_URL="${1%/}"
API_BASE="${2%/}"

echo "[1/4] Checking backend health..."
HEALTH_JSON="$(curl -fsS "${API_BASE}/health")"
echo "Health: ${HEALTH_JSON}"

echo "${HEALTH_JSON}" | grep -q '"status":"ok"' || {
  echo "Health check failed: status!=ok"
  exit 1
}

echo "${HEALTH_JSON}" | grep -q '"storage_mode":"postgres"' || {
  echo "Warning: storage_mode is not postgres"
}

echo "[2/4] Starting demo decision..."
START_JSON="$(curl -fsS -X POST "${API_BASE}/decisions/start" \
  -H 'Content-Type: application/json' \
  -d '{"estimated_kwh":550,"threshold":40,"zone":"SE-SE3","demo_scenario":"clean_local"}')"
echo "Start: ${START_JSON}"

DECISION_ID="$(echo "${START_JSON}" | sed -n 's/.*"decision_id":"\([^"]*\)".*/\1/p')"
if [[ -z "${DECISION_ID}" ]]; then
  echo "Could not parse decision_id from start response"
  exit 1
fi

echo "[3/4] Polling decision (${DECISION_ID})..."
for i in {1..15}; do
  POLL_JSON="$(curl -fsS "${API_BASE}/decisions/${DECISION_ID}")"
  STATUS="$(echo "${POLL_JSON}" | sed -n 's/.*"status":"\([^"]*\)".*/\1/p')"
  echo "Attempt ${i}: status=${STATUS}"
  if [[ "${STATUS}" == "completed" || "${STATUS}" == "postponed" || "${STATUS}" == "awaiting_approval" ]]; then
    break
  fi
  sleep 2
done

echo "[4/4] Checking frontend URL..."
curl -I -fsS "${FRONTEND_URL}" | head -n 1

echo "Smoke checks finished."
