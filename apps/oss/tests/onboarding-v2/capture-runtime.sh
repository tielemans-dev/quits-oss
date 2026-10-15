#!/usr/bin/env bash
set -euo pipefail
capture_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)
cd "$capture_root"
: "${DATABASE_URL:?Use a migrated disposable local qui56_screens_20261012 database}"
: "${QUI56_BASELINE_DIR:?Use an independently installed detached main checkout}"
export SCREENSHOT_OUTPUT="${SCREENSHOT_OUTPUT:-$capture_root/.artifacts/qui-56-screens-refresh}"
mkdir -p "$SCREENSHOT_OUTPUT"
export PLAYWRIGHT_BASE_URL=http://127.0.0.1:3086
export QUITS_DISTRIBUTION=cloud VITE_QUITS_DISTRIBUTION=cloud
export BETTER_AUTH_URL=http://127.0.0.1:3086 QUITS_APP_ORIGIN=http://127.0.0.1:3086
export BETTER_AUTH_SECRET=synthetic-qui56-screen-secret-over-32-characters
export EMAIL_PROVIDER='' RESEND_API_KEY='' SMTP_HOST='' STRIPE_SECRET_KEY='' OPENROUTER_API_KEY=''
for capture_phase in ${CAPTURE_PHASES:-before after}; do
 export SCREENSHOT_PHASE="$capture_phase"
 if [ "$capture_phase" = before ]; then export SCREENSHOT_CWD="$QUI56_BASELINE_DIR"; else export SCREENSHOT_CWD="$capture_root"; fi
 (cd apps/oss && bunx playwright test -c playwright.runtime-captures.config.ts --workers=1)
done
