#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

status=0

check_absent() {
  local pattern="$1"
  local description="$2"
  shift 2
  local paths=("$@")

  if rg -n -S "$pattern" "${paths[@]}"; then
    echo ""
    echo "Boundary check failed: $description"
    status=1
  else
    echo "Boundary check passed: $description"
  fi
}

check_absent "from ['\"]stripe['\"]|require\\(['\"]stripe['\"]\\)|@stripe" \
  "Stripe SDK imports are not allowed in OSS runtime" \
  apps/oss/src apps/oss/package.json

check_absent "api/webhooks/stripe|webhooks/stripe" \
  "Stripe webhook routes are not allowed in OSS runtime" \
  apps/oss/src/routes

check_absent "STRIPE_" \
  "STRIPE_* variables are not allowed in OSS templates/docs" \
  .env.example README.md docker-compose.yml

check_absent "yaip-cloud|quits-cloud|@yaip/cloud|@quits/cloud|cloud-private" \
  "OSS runtime must not import private cloud modules" \
  apps/oss/src apps/oss/package.json

if [[ "$status" -ne 0 ]]; then
  exit "$status"
fi

echo "All OSS boundary checks passed."
