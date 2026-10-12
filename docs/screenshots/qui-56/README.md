# QUI-56 screenshots

Light and dark themes, Danish and English, desktop 1280 × 800 and mobile 390 × 844. Images capture the full page. All company and bank values are synthetic fixtures.

Before uses the actual onboarding and dashboard welcome components from main `4931661d`, with mocked auth and transports. Main has no CVR search, lookup, summary, suggestion, or bank-nudge screens. Its cloud manual form still has English copy even with the Danish locale selected. New screens are labelled as additions rather than reconstructed “before” screens.

After uses the production components from this PR. Dashboard images isolate the changed first-run component; the app shell and existing trial banner are outside this component fixture. Bank-nudge images show the production dialog opened by its send hook.

## Light theme

### Before: main

| Screen | DA desktop | DA mobile | EN desktop | EN mobile |
| --- | --- | --- | --- | --- |
| before-manual | [PNG](before-manual-da-desktop-light.png) | [PNG](before-manual-da-mobile-light.png) | [PNG](before-manual-en-desktop-light.png) | [PNG](before-manual-en-mobile-light.png) |
| before-dashboard | [PNG](before-dashboard-da-desktop-light.png) | [PNG](before-dashboard-da-mobile-light.png) | [PNG](before-dashboard-en-desktop-light.png) | [PNG](before-dashboard-en-mobile-light.png) |

### After: onboarding v2

| Screen | DA desktop | DA mobile | EN desktop | EN mobile |
| --- | --- | --- | --- | --- |
| 01-search | [PNG](01-search-da-desktop-light.png) | [PNG](01-search-da-mobile-light.png) | [PNG](01-search-en-desktop-light.png) | [PNG](01-search-en-mobile-light.png) |
| 01-search-results | [PNG](01-search-results-da-desktop-light.png) | [PNG](01-search-results-da-mobile-light.png) | [PNG](01-search-results-en-desktop-light.png) | [PNG](01-search-results-en-mobile-light.png) |
| 02-working | [PNG](02-working-da-desktop-light.png) | [PNG](02-working-da-mobile-light.png) | [PNG](02-working-en-desktop-light.png) | [PNG](02-working-en-mobile-light.png) |
| 03-summary | [PNG](03-summary-da-desktop-light.png) | [PNG](03-summary-da-mobile-light.png) | [PNG](03-summary-en-desktop-light.png) | [PNG](03-summary-en-mobile-light.png) |
| 05-not-found | [PNG](05-not-found-da-desktop-light.png) | [PNG](05-not-found-da-mobile-light.png) | [PNG](05-not-found-en-desktop-light.png) | [PNG](05-not-found-en-mobile-light.png) |
| 05b-invalid-cvr | [PNG](05b-invalid-cvr-da-desktop-light.png) | [PNG](05b-invalid-cvr-da-mobile-light.png) | [PNG](05b-invalid-cvr-en-desktop-light.png) | [PNG](05b-invalid-cvr-en-mobile-light.png) |
| 06-several-matches | [PNG](06-several-matches-da-desktop-light.png) | [PNG](06-several-matches-da-mobile-light.png) | [PNG](06-several-matches-en-desktop-light.png) | [PNG](06-several-matches-en-mobile-light.png) |
| 07-no-vat | [PNG](07-no-vat-da-desktop-light.png) | [PNG](07-no-vat-da-mobile-light.png) | [PNG](07-no-vat-en-desktop-light.png) | [PNG](07-no-vat-en-mobile-light.png) |
| 08-ceased | [PNG](08-ceased-da-desktop-light.png) | [PNG](08-ceased-da-mobile-light.png) | [PNG](08-ceased-en-desktop-light.png) | [PNG](08-ceased-en-mobile-light.png) |
| 08b-warning | [PNG](08b-warning-da-desktop-light.png) | [PNG](08b-warning-da-mobile-light.png) | [PNG](08b-warning-en-desktop-light.png) | [PNG](08b-warning-en-mobile-light.png) |
| 09-lookup-failed | [PNG](09-lookup-failed-da-desktop-light.png) | [PNG](09-lookup-failed-da-mobile-light.png) | [PNG](09-lookup-failed-en-desktop-light.png) | [PNG](09-lookup-failed-en-mobile-light.png) |
| 10-timeout | [PNG](10-timeout-da-desktop-light.png) | [PNG](10-timeout-da-mobile-light.png) | [PNG](10-timeout-en-desktop-light.png) | [PNG](10-timeout-en-mobile-light.png) |
| 11-manual | [PNG](11-manual-da-desktop-light.png) | [PNG](11-manual-da-mobile-light.png) | [PNG](11-manual-en-desktop-light.png) | [PNG](11-manual-en-mobile-light.png) |
| 12-dashboard | [PNG](12-dashboard-da-desktop-light.png) | [PNG](12-dashboard-da-mobile-light.png) | [PNG](12-dashboard-en-desktop-light.png) | [PNG](12-dashboard-en-mobile-light.png) |
| 15-save-failed | [PNG](15-save-failed-da-desktop-light.png) | [PNG](15-save-failed-da-mobile-light.png) | [PNG](15-save-failed-en-desktop-light.png) | [PNG](15-save-failed-en-mobile-light.png) |
| 16-confirming | [PNG](16-confirming-da-desktop-light.png) | [PNG](16-confirming-da-mobile-light.png) | [PNG](16-confirming-en-desktop-light.png) | [PNG](16-confirming-en-mobile-light.png) |
| 17-agent-failed | [PNG](17-agent-failed-da-desktop-light.png) | [PNG](17-agent-failed-da-mobile-light.png) | [PNG](17-agent-failed-en-desktop-light.png) | [PNG](17-agent-failed-en-mobile-light.png) |
| 18-suggestions-loading | [PNG](18-suggestions-loading-da-desktop-light.png) | [PNG](18-suggestions-loading-da-mobile-light.png) | [PNG](18-suggestions-loading-en-desktop-light.png) | [PNG](18-suggestions-loading-en-mobile-light.png) |
| 19-restored | [PNG](19-restored-da-desktop-light.png) | [PNG](19-restored-da-mobile-light.png) | [PNG](19-restored-en-desktop-light.png) | [PNG](19-restored-en-mobile-light.png) |
| 20-bank-nudge | [PNG](20-bank-nudge-da-desktop-light.png) | [PNG](20-bank-nudge-da-mobile-light.png) | [PNG](20-bank-nudge-en-desktop-light.png) | [PNG](20-bank-nudge-en-mobile-light.png) |
| 21-bank-filled | [PNG](21-bank-filled-da-desktop-light.png) | [PNG](21-bank-filled-da-mobile-light.png) | [PNG](21-bank-filled-en-desktop-light.png) | [PNG](21-bank-filled-en-mobile-light.png) |
| 22-bank-invalid | [PNG](22-bank-invalid-da-desktop-light.png) | [PNG](22-bank-invalid-da-mobile-light.png) | [PNG](22-bank-invalid-en-desktop-light.png) | [PNG](22-bank-invalid-en-mobile-light.png) |

## Dark theme

### Before: main

| Screen | DA desktop | DA mobile | EN desktop | EN mobile |
| --- | --- | --- | --- | --- |
| before-manual | [PNG](before-manual-da-desktop-dark.png) | [PNG](before-manual-da-mobile-dark.png) | [PNG](before-manual-en-desktop-dark.png) | [PNG](before-manual-en-mobile-dark.png) |
| before-dashboard | [PNG](before-dashboard-da-desktop-dark.png) | [PNG](before-dashboard-da-mobile-dark.png) | [PNG](before-dashboard-en-desktop-dark.png) | [PNG](before-dashboard-en-mobile-dark.png) |

### After: onboarding v2

| Screen | DA desktop | DA mobile | EN desktop | EN mobile |
| --- | --- | --- | --- | --- |
| 01-search | [PNG](01-search-da-desktop-dark.png) | [PNG](01-search-da-mobile-dark.png) | [PNG](01-search-en-desktop-dark.png) | [PNG](01-search-en-mobile-dark.png) |
| 01-search-results | [PNG](01-search-results-da-desktop-dark.png) | [PNG](01-search-results-da-mobile-dark.png) | [PNG](01-search-results-en-desktop-dark.png) | [PNG](01-search-results-en-mobile-dark.png) |
| 02-working | [PNG](02-working-da-desktop-dark.png) | [PNG](02-working-da-mobile-dark.png) | [PNG](02-working-en-desktop-dark.png) | [PNG](02-working-en-mobile-dark.png) |
| 03-summary | [PNG](03-summary-da-desktop-dark.png) | [PNG](03-summary-da-mobile-dark.png) | [PNG](03-summary-en-desktop-dark.png) | [PNG](03-summary-en-mobile-dark.png) |
| 05-not-found | [PNG](05-not-found-da-desktop-dark.png) | [PNG](05-not-found-da-mobile-dark.png) | [PNG](05-not-found-en-desktop-dark.png) | [PNG](05-not-found-en-mobile-dark.png) |
| 05b-invalid-cvr | [PNG](05b-invalid-cvr-da-desktop-dark.png) | [PNG](05b-invalid-cvr-da-mobile-dark.png) | [PNG](05b-invalid-cvr-en-desktop-dark.png) | [PNG](05b-invalid-cvr-en-mobile-dark.png) |
| 06-several-matches | [PNG](06-several-matches-da-desktop-dark.png) | [PNG](06-several-matches-da-mobile-dark.png) | [PNG](06-several-matches-en-desktop-dark.png) | [PNG](06-several-matches-en-mobile-dark.png) |
| 07-no-vat | [PNG](07-no-vat-da-desktop-dark.png) | [PNG](07-no-vat-da-mobile-dark.png) | [PNG](07-no-vat-en-desktop-dark.png) | [PNG](07-no-vat-en-mobile-dark.png) |
| 08-ceased | [PNG](08-ceased-da-desktop-dark.png) | [PNG](08-ceased-da-mobile-dark.png) | [PNG](08-ceased-en-desktop-dark.png) | [PNG](08-ceased-en-mobile-dark.png) |
| 08b-warning | [PNG](08b-warning-da-desktop-dark.png) | [PNG](08b-warning-da-mobile-dark.png) | [PNG](08b-warning-en-desktop-dark.png) | [PNG](08b-warning-en-mobile-dark.png) |
| 09-lookup-failed | [PNG](09-lookup-failed-da-desktop-dark.png) | [PNG](09-lookup-failed-da-mobile-dark.png) | [PNG](09-lookup-failed-en-desktop-dark.png) | [PNG](09-lookup-failed-en-mobile-dark.png) |
| 10-timeout | [PNG](10-timeout-da-desktop-dark.png) | [PNG](10-timeout-da-mobile-dark.png) | [PNG](10-timeout-en-desktop-dark.png) | [PNG](10-timeout-en-mobile-dark.png) |
| 11-manual | [PNG](11-manual-da-desktop-dark.png) | [PNG](11-manual-da-mobile-dark.png) | [PNG](11-manual-en-desktop-dark.png) | [PNG](11-manual-en-mobile-dark.png) |
| 12-dashboard | [PNG](12-dashboard-da-desktop-dark.png) | [PNG](12-dashboard-da-mobile-dark.png) | [PNG](12-dashboard-en-desktop-dark.png) | [PNG](12-dashboard-en-mobile-dark.png) |
| 15-save-failed | [PNG](15-save-failed-da-desktop-dark.png) | [PNG](15-save-failed-da-mobile-dark.png) | [PNG](15-save-failed-en-desktop-dark.png) | [PNG](15-save-failed-en-mobile-dark.png) |
| 16-confirming | [PNG](16-confirming-da-desktop-dark.png) | [PNG](16-confirming-da-mobile-dark.png) | [PNG](16-confirming-en-desktop-dark.png) | [PNG](16-confirming-en-mobile-dark.png) |
| 17-agent-failed | [PNG](17-agent-failed-da-desktop-dark.png) | [PNG](17-agent-failed-da-mobile-dark.png) | [PNG](17-agent-failed-en-desktop-dark.png) | [PNG](17-agent-failed-en-mobile-dark.png) |
| 18-suggestions-loading | [PNG](18-suggestions-loading-da-desktop-dark.png) | [PNG](18-suggestions-loading-da-mobile-dark.png) | [PNG](18-suggestions-loading-en-desktop-dark.png) | [PNG](18-suggestions-loading-en-mobile-dark.png) |
| 19-restored | [PNG](19-restored-da-desktop-dark.png) | [PNG](19-restored-da-mobile-dark.png) | [PNG](19-restored-en-desktop-dark.png) | [PNG](19-restored-en-mobile-dark.png) |
| 20-bank-nudge | [PNG](20-bank-nudge-da-desktop-dark.png) | [PNG](20-bank-nudge-da-mobile-dark.png) | [PNG](20-bank-nudge-en-desktop-dark.png) | [PNG](20-bank-nudge-en-mobile-dark.png) |
| 21-bank-filled | [PNG](21-bank-filled-da-desktop-dark.png) | [PNG](21-bank-filled-da-mobile-dark.png) | [PNG](21-bank-filled-en-desktop-dark.png) | [PNG](21-bank-filled-en-mobile-dark.png) |
| 22-bank-invalid | [PNG](22-bank-invalid-da-desktop-dark.png) | [PNG](22-bank-invalid-da-mobile-dark.png) | [PNG](22-bank-invalid-en-desktop-dark.png) | [PNG](22-bank-invalid-en-mobile-dark.png) |

## Reproduce

Create a detached main checkout, and install the repository dependencies. Set `QUI56_BASELINE_DIR` to that checkout, then start `bunx vite --config tests/onboarding-v2/screenshots.vite.config.ts` from `apps/oss`.

The capture runner uses Python Playwright. Run it from the repository root through the fleet queue on Omarchy:

```sh
fleet-heavy -- python apps/oss/tests/onboarding-v2/capture-screenshots.py \
  --output docs/screenshots/qui-56 \
  --chromium /path/to/playwright/chromium/chrome \
  --workers 1
```

The screenshot-only Vite configuration replaces auth, routing and transports with stable fixtures. It is separate from the acceptance-test configuration and does not affect the product runtime.

## Stack maintenance evidence status

The maintenance merge `3639056bc674d004524e8ee31f34cde6b0f8a8ae` has both published heads as parents:

- PR122 `ad07867326c857db5f558a06e5c2ac57e3d403e4`.
- PR121 `e7ba391ea9757dd270fffe5d4f54e3455e4c45dc`.

It carries the latest confirmation guards, trial hook, protected-contact scrubbing, saved document defaults, and numbering preservation. The screen review still supports editable defaults and manual entry without a CVR. Existing numbering takes precedence over an edited review prefix. The original migration and approved `COPY.md` are unchanged.

The registration boolean already flowed from the review draft into confirmation. Maintenance makes both sources display the existing Yes/No translations and adds checks for both registration choices, draft reload, CVR/manual confirmation persistence, and screen-year rollover. The existing component acceptance suite now runs in CI with one worker. Its transport is a fixture, so it does not prove authenticated app/database behavior. The database regressions use the production confirmation and settings APIs.

The historical images above remain unchanged. They use main `4931661d` and production components with mocked auth/transports. They are not fresh current-main versus maintained-head authenticated onboarding evidence. The [actual-app refresh](../../qa/qui-56-screens-refresh/README.md) adds authenticated current-main/after onboarding steps and manual entry in DA/EN, light theme, 1440px desktop and 390px mobile. Dark-theme images remain the historical component fixtures above. Ines approval remains required.

Two focused unit suites passed with one worker, 32 tests total. Scoped lint passed with one thread. A first bank-nudge run failed to collect because a dependency file was missing; after reinstalling the worktree's frozen dependencies, both suites passed. Full lint, typecheck, tests, build, browser checks, and database regressions are delegated to new-head CI. Earlier green runs belong to the original heads and do not prove the maintained head.

Integration order remains PR121, PR122, PR129, PR132. PR129 should merge the maintained PR122 head normally and retain the existing external history. No PR129 or PR132 source changes belong to this maintenance.

The actual-app refresh also records final local quality, affected database/unit, and browser checks after adopting this maintenance head. Its synthetic registry and billing providers are explicitly documented.
