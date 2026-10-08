#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
command -v rg >/dev/null || { echo "Boundary regression tests require ripgrep." >&2; exit 2; }
TEST_ROOT=$(mktemp -d)
trap 'rm -rf "$TEST_ROOT"' EXIT
fixture_count=0
test_count=0
bash_path=$(command -v bash)
dirname_path=$(command -v dirname)

new_fixture() {
  fixture_count=$((fixture_count + 1))
  fixture="$TEST_ROOT/$fixture_count"
  mkdir -p "$fixture/scripts" "$fixture/apps/oss/src/routes" "$fixture/apps/oss/src/lib/payments" "$fixture/bin"
  cp "$REPO_ROOT/scripts/check-oss-boundaries.sh" "$fixture/scripts/"
  printf '{}\n' > "$fixture/apps/oss/package.json"
  printf '\n' > "$fixture/.env.example"
  printf '\n' > "$fixture/README.md"
  printf '\n' > "$fixture/docker-compose.yml"
  printf 'export const routes = []\n' > "$fixture/apps/oss/src/routes/index.ts"
}

run_from_script_directory() {
  local interpreter=$1 script=$2
  (cd "${script%/*}" && "$interpreter" "${script##*/}")
}

expect_result() {
  local expected_status=$1 expected_message=$2
  shift 2
  local output actual_status=0
  output=$("$@" "$bash_path" "$fixture/scripts/check-oss-boundaries.sh" 2>&1) || actual_status=$?
  if [[ "$actual_status" != "$expected_status" || "$output" != *"$expected_message"* ]]; then
    printf 'Expected exit %s and message %s, got exit %s:\n%s\n' "$expected_status" "$expected_message" "$actual_status" "$output" >&2
    exit 1
  fi
  if [[ "$expected_status" != 0 && "$output" == *"All OSS boundary checks passed."* ]]; then
    echo "A failing check reported success." >&2
    exit 1
  fi
  test_count=$((test_count + 1))
}

# A clean tree, including the already-present customer invoice provider and
# payment webhook route, passes without ignoring the rest of those paths.
new_fixture
expect_result 0 "All OSS boundary checks passed."
expect_result 0 "All OSS boundary checks passed." run_from_script_directory
printf 'import Stripe from "stripe"\nconst stripe = new Stripe("invoice-key")\nstripe.checkout.sessions.create({ mode: "payment" })\nstripe.webhooks.constructEvent(body, signature, secret)\n' > "$fixture/apps/oss/src/lib/payments/stripe.ts"
printf 'const route = "/api/payments/stripe-webhook"\n' > "$fixture/apps/oss/src/routes/payment.ts"
expect_result 0 "All OSS boundary checks passed."

# Static import, CommonJS, and @stripe references keep their original regex
# behavior, including smart-case matching. No directory-wide exemption exists.
for code in 'import Stripe from "stripe"' "import Stripe from 'stripe'" 'const Stripe = require("stripe")' 'import { loadStripe } from "@stripe/stripe-js"' 'import Stripe from "STRIPE"'; do
  new_fixture
  printf '%s\n' "$code" > "$fixture/apps/oss/src/lib/payments/other.ts"
  expect_result 1 "other.ts:1:$code"
done

new_fixture
printf 'import Stripe from "stripe"\nimport { loadStripe } from "@stripe/stripe-js"\n' > "$fixture/apps/oss/src/lib/payments/stripe.ts"
expect_result 1 'stripe.ts:2:import { loadStripe } from "@stripe/stripe-js"'
new_fixture
printf 'import Stripe from "stripe"; const portal = true\n' > "$fixture/apps/oss/src/lib/payments/stripe.ts"
expect_result 1 'stripe.ts:1:import Stripe from "stripe"; const portal = true'

# Hosted lifecycle operations stay forbidden even inside the invoice provider.
for code in 'stripe.subscriptions.create({})' 'stripe.subscriptionSchedules.create({})' 'stripe.billingPortal.sessions.create({})' 'const event = "customer.subscription.updated"' 'const event = "subscription_schedule.created"' 'stripe.checkout.sessions.create({ mode: "subscription" })'; do
  new_fixture
  printf 'import Stripe from "stripe"\n%s\n' "$code" > "$fixture/apps/oss/src/lib/payments/stripe.ts"
  expect_result 1 "stripe.ts:2:$code"
done

new_fixture
printf 'const route = "/api/webhooks/stripe"\n' > "$fixture/apps/oss/src/routes/hosted.ts"
expect_result 1 "Stripe webhook routes are not allowed"
new_fixture
printf 'STRIPE_SECRET_KEY=example\n' > "$fixture/.env.example"
expect_result 1 "STRIPE_* variables are not allowed"
new_fixture
printf 'import cloud from "@quits/cloud"\n' > "$fixture/apps/oss/src/private.ts"
expect_result 1 "OSS runtime must not import private cloud modules"
new_fixture
printf '{ "dependencies": { "@stripe/stripe-js": "latest" } }\n' > "$fixture/apps/oss/package.json"
expect_result 1 "apps/oss/package.json:1:"

# A developer's ripgrep config must not disable the repository search.
new_fixture
printf 'import Stripe from "stripe"\n' > "$fixture/apps/oss/src/forbidden.ts"
printf '%s\n' '--glob=!**' > "$fixture/rg-config"
expect_result 1 'forbidden.ts:1:import Stripe from "stripe"' env "RIPGREP_CONFIG_PATH=$fixture/rg-config"

# Missing rg must fail before attempting any searches, regardless of PATH.
new_fixture
expect_result 2 "ripgrep (rg) is required" env "PATH=$fixture/bin"

# rg can emit matches and still exit 2, for example with an unreadable path.
# Neither such partial results nor a tool execution failure can report a pass.
for search_status in 2 126; do
  new_fixture
  ln -s "$dirname_path" "$fixture/bin/dirname"
  cat > "$fixture/bin/rg" <<EOF
#!/bin/bash
echo 'apps/oss/src/lib/payments/stripe.ts:1:import Stripe from "stripe"'
exit $search_status
EOF
  chmod +x "$fixture/bin/rg"
  expect_result 2 "rg exited $search_status" env "PATH=$fixture/bin"
done

# Exercise a real ripgrep I/O error as well as the simulated tool errors.
new_fixture
rm "$fixture/apps/oss/package.json"
expect_result 2 "rg exited 2"
new_fixture
rm "$fixture/README.md"
expect_result 2 "rg exited 2"

printf 'OSS boundary regression tests passed (%s cases).\n' "$test_count"
