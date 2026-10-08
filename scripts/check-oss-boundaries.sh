#!/usr/bin/env bash
set -euo pipefail

if ! command -v rg >/dev/null 2>&1; then
  echo "Boundary check error: ripgrep (rg) is required. Install ripgrep and retry." >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

status=0

check_absent() {
  local pattern="$1"
  local description="$2"
  shift 2
  local paths=("$@")

  local matches search_status=0 match content forbidden=0
  # Keep smart-case regex matching. Fixed output flags make the exact-line
  # exception independent of terminal settings and user ripgrep configuration.
  matches=$(rg --no-config --color never --no-heading --with-filename -n -S -- "$pattern" "${paths[@]}") || search_status=$?
  case "$search_status" in
    0)
      while IFS= read -r match; do
        content=${match#*:}
        content=${content#*:}
        # Customer invoice Checkout is OSS functionality. Allow only its
        # existing SDK import, never a whole file or payments directory.
        if [[ "$description" == "$stripe_import_description" &&
              "${match%%:*}" == "apps/oss/src/lib/payments/stripe.ts" &&
              "$content" == 'import Stripe from "stripe"' ]]; then
          continue
        fi
        echo "$match"
        forbidden=1
      done <<< "$matches"
      ;;
    1) ;;
    *)
      echo "Boundary check error: $description (rg exited $search_status)" >&2
      exit 2
      ;;
  esac

  if [[ "$forbidden" -ne 0 ]]; then
    echo "Boundary check failed: $description"
    status=1
  else
    echo "Boundary check passed: $description"
  fi
}

stripe_import_description="Stripe SDK imports are restricted to the customer invoice payment provider"
check_absent "from ['\"]stripe['\"]|require\\(['\"]stripe['\"]\\)|@stripe" \
  "$stripe_import_description" \
  apps/oss/src apps/oss/package.json

check_absent "\\.(subscriptions|subscriptionSchedules|billingPortal)[[:space:]]*\\.|['\"](customer\\.subscription\\.|subscription_schedule\\.)|mode[[:space:]]*:[[:space:]]*['\"]subscription['\"]" \
  "Hosted Stripe subscription and billing portal lifecycle code is not allowed in OSS runtime" \
  apps/oss/src

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
