# QUI-56 actual-app onboarding evidence

This refresh supplements the [original 192-image component gallery](../../screenshots/qui-56/README.md). Those PNGs are preserved byte for byte. The [parent form/PDF evidence](../qui-56-review/README.md) also remains intact.

The before application is main `c42c4e7b61a1f1b1cce0d130cf46f94cc585c9c6`. The after production tree is `e82037d2b8d960bb3aa12cb14a24faed6b63c356`, including published PR121 parent `e7ba391ea9757dd270fffe5d4f54e3455e4c45dc` and PR122 maintenance `21b23763a227b3f30998102d81a8d74352ba7825`. Both were integrated with normal merges. Existing invoice/quote prefix and counter history take precedence over edited review numbering. Non-numbering review defaults remain editable.

## Capture scope and limits

These 32 full-page light-theme PNGs use the real Vite application, authenticated session, active organization, app shell, routes, tRPC handlers and migrated disposable database. The viewport is 1440 × 1000 on desktop and 390 × 844 on mobile; full-page PNG heights vary. Each state is captured in Danish and English. The original gallery retains the dark-theme and additional error/status coverage with its documented component-fixture limits.

All identities, company names, addresses and account data are synthetic. The dedicated local database is `qui56_screens_20261012`. The after server uses a capture-only supported runtime extension with onboarding V2 enabled and non-VAT registration disabled. It supplies a synthetic CVR search/get provider with a 2.5-second lookup delay and a no-op billing trial provider. There are no real registry requests, live billing operations or hosted provisioning. The captures do not prove production provider availability or the hosted trial lifecycle. No app UI, auth, routes or transport are replaced by screenshot components.

Before/main has only the existing manual onboarding form, including English body copy when the shell is Danish. Its loaded saved country is asserted as DK before either capture. The runner asserts that "Loading onboarding state…" has disappeared, types a manual company name and address, and checks both retained values. The after review asserts DK and the manual-entry capture checks both typed values. Manual-entered pictures show local edits before confirmation, not a successful database save. The lookup image deliberately shows the actual intermediate loading step; it is separate from the completed review.

## Before/main

| State | DA desktop | DA mobile | EN desktop | EN mobile |
| --- | --- | --- | --- | --- |
| Loaded manual form | [PNG](before-manual-da-desktop.png) | [PNG](before-manual-da-mobile.png) | [PNG](before-manual-en-desktop.png) | [PNG](before-manual-en-mobile.png) |
| Typed manual form | [PNG](before-manual-entered-da-desktop.png) | [PNG](before-manual-entered-da-mobile.png) | [PNG](before-manual-entered-en-desktop.png) | [PNG](before-manual-entered-en-mobile.png) |

## After

| State | DA desktop | DA mobile | EN desktop | EN mobile |
| --- | --- | --- | --- | --- |
| 1. Company search | [PNG](after-01-company-da-desktop.png) | [PNG](after-01-company-da-mobile.png) | [PNG](after-01-company-en-desktop.png) | [PNG](after-01-company-en-mobile.png) |
| Search results | [PNG](after-01-results-da-desktop.png) | [PNG](after-01-results-da-mobile.png) | [PNG](after-01-results-en-desktop.png) | [PNG](after-01-results-en-mobile.png) |
| 2. Registry lookup | [PNG](after-02-lookup-da-desktop.png) | [PNG](after-02-lookup-da-mobile.png) | [PNG](after-02-lookup-en-desktop.png) | [PNG](after-02-lookup-en-mobile.png) |
| 3. Editable review | [PNG](after-03-review-da-desktop.png) | [PNG](after-03-review-da-mobile.png) | [PNG](after-03-review-en-desktop.png) | [PNG](after-03-review-en-mobile.png) |
| Manual fallback | [PNG](after-manual-da-desktop.png) | [PNG](after-manual-da-mobile.png) | [PNG](after-manual-en-desktop.png) | [PNG](after-manual-en-mobile.png) |
| Typed manual fallback | [PNG](after-manual-entered-da-desktop.png) | [PNG](after-manual-entered-da-mobile.png) | [PNG](after-manual-entered-en-desktop.png) | [PNG](after-manual-entered-en-mobile.png) |

## Supported setup and verification

Both independent checkouts have frozen dependencies and generated Prisma clients. The capture runner uses the production Vite configuration rather than reconstructed screens. The virtual TanStack client entry returns HTTP 200. A cold after run initially failed because overlapping SSR dependency imports exposed an unfinished tRPC router, causing HTTP 500 with an undefined `_def`. Sharing one ordered dependency-import promise per handler module fixes that failure; a rejected import clears the promise for retry. Authentication and request context still run for each request.

To reproduce, prepare an independently installed main checkout at the SHA above and a migrated disposable local database. Export `DATABASE_URL` privately and `QUI56_BASELINE_DIR` as the checkout path. The runner rejects other database names or non-local hosts before resetting fixtures. It replaces fixtures in that database. From the repository root on Omarchy, run:

```sh
fleet-heavy -- bash apps/oss/tests/onboarding-v2/capture-runtime.sh
```

The runner starts each server only for its capture phase and closes it after completion, with one Playwright worker. `CAPTURE_PHASES=before` or `CAPTURE_PHASES=after` selects a phase. No private credentials are committed.

Final verification after adopting the published maintenance head passed through outer Fleet commands with one worker:

- Repository lint, whole-workspace typecheck, i18n validation and OSS boundary checks.
- 87 affected unit/integration tests in seven files, including 44 confirmation integration tests, edited VAT registration choices, numbering preservation, Danish defaults/year rollover, bank nudge, onboarding organization selection and invoice due-date defaults.
- Actual-app before capture on current main, eight PNGs, and after capture on the integrated tree, 24 PNGs, with the assertions described above.
- All 14 component browser acceptance tests, including double-submit, retry identity, reload/leave behavior, manual fallback, lookup timeout, suggestions, mobile English, and both VAT choices surviving reload and submission.
- All 192 original PNGs compared byte for byte against PR122 head `ad078673`.

One final after-capture attempt stalled on the app shell's organization-loading placeholder while host pressure was elevated. It recorded no HTTP 500. A queued after-only retry completed all assertions and captures in 40.3 seconds, followed by all 14 browser tests in 44.8 seconds. This retry is the final after evidence. The earlier incomplete attempt is not published as visual evidence. The component test server also logged unresolved historical screenshot aliases during dependency scanning; all 14 acceptance tests still passed. The separate actual-app capture server has no such fixture aliases.

The parent's reported full-suite result belongs to PR121, not a newly run PR122 full suite. This refresh ran the affected tests and required quality/browser checks. Parent CI remains owned by the orchestrator. PR122 stays draft until its own new-head CI is green. Ines approval is still required before readiness for Kai. Hosted non-VAT registration remains off until QUI-62.
