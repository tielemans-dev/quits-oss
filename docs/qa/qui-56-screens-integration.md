# PR122 validated-parent integration

PR122 remains draft. This integration adds exact validated PR121 commit
`30ae782630c6a1129c220a5319b4197b3a39049f` to `qui-56-screens`, whose base remains
`qui-56-confirm-v2`. The original head is
`a3ac9d3b66f983cc77b929fa9104c0553d88272a`, retained by local ref
`refs/backup/pr122-before-validated121-20261012`. A normal merge preserves the
original ancestry, including prior parent `e7ba391ea9757dd270fffe5d4f54e3455e4c45dc`
and published screen maintenance `21b23763a227b3f30998102d81a8d74352ba7825`.
The observed current main is `b6d531604ad483572633b76af1cb652f5aadcd74`.

Seven conflicts were resolved by comparing both complete versions:

- `confirm-v2.ts` retains editable review defaults and optional manual CVR insertion.
- `onboarding-v2.test.ts` retains draft registration/year coverage and adds the parent's rejected counter boundary.
- `onboarding-v2.ts` in contracts retains manual validation and final CVR/VAT binding, with the parent's maximum initial counter of 2147483646.
- `-new-document-tax-defaults.test.tsx` retains the partial router mock with real Link exports.
- `invoices/new.tsx` retains the bank-nudge import and behavior.
- `onboarding-v2.integration.test.ts` retains registration persistence, manual fallback and edited defaults tests.
- `onboarding-v2-export.integration.test.ts` retains the validated parent file exactly, including charged-VAT rejection before numbers/artifacts and frozen credit PDF identifiers/reason/history.

The parent financial repair files and export regressions match the validated
parent exactly. Screen source, bilingual onboarding copy, original gallery,
authenticated historical gallery and parent evidence remain unchanged. No
pricing repair was duplicated, and no legal O classification was forced.

## Verification on the integrated tree

- 55 focused tests pass across six onboarding, draft, bank-nudge and route files with one worker. This includes all 14 document-default route tests using the retained partial router mock.
- 13 VAT issuance and frozen credit PDF party tests pass with one worker.
- Scoped lint passes on 44 changed source files, with no warnings or errors.
- i18n validation and translation-memory checks pass.
- Diff whitespace checks pass; no unresolved index entries remain.

No install, full suite, typecheck, build, database integration run, browser or
server was run locally for this integration. Full suite, typecheck, build and
browser validation belong to new-head CI. Parent database export acceptance is
previously validated PR121 evidence, not a new PR122 run.

## Remaining stack and evidence gates

The ordinary unregistered `unclassified_zero` refusal requirement belongs to
PR129's existing `ae8c723223b3dfcafe9ed46602fecd42cc6ba217` contextual shared
validator/guard using parent-audited `momsRegistered`. Integrate and verify it in
PR129 after PR122, preserving the Link mock fix for its known failures. The order
remains 121, 122, 129, 132. Hosted non-VAT enablement remains gated on QUI-62;
self-hosted installations retain their existing flow without hosted gates.

`.github/workflows/ci.yml` runs full lint, typecheck, unit/router and integration
tests, build, one-worker onboarding component acceptance, browser smoke and
shared product browser scenarios. Its capture jobs cover QUI-64 and the
PR130-only quote evidence job. The PR122-only authenticated QUI-56 runtime capture job is now included in the
existing CI workflow, so it can execute before merge. It runs only for relevant
PR122 changes. A green ordinary CI run alone cannot satisfy the visual evidence gate.

Fresh authenticated current-main before and integrated-head after captures are
still required in CI, followed by Ines approval. The original mock-auth gallery
and the historical authenticated gallery do not prove this head. No new images
were generated here. Readiness is pending both evidence and approval.

For a CI evidence run, prepare independent exact-SHA main/head checkouts with
frozen dependencies, generated Prisma clients and deployed migrations in a
disposable localhost database named `qui56_screens_20261012`. Install the pinned
Playwright Chromium in CI. Record application and harness SHAs, run URL and
synthetic runtime-provider limits alongside uploaded PNGs and diagnostics.
The existing runner signs in through real auth, selects the active organization,
asserts loaded DK defaults, and checks retained manual name/address edits. Its
synthetic CVR/billing providers do not validate production provider availability
or trial provisioning. Manual-entered captures precede confirmation and do not
prove a completed manual save.

From the head checkout, the existing capture command for the authorized CI
runner is:

```sh
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/qui56_screens_20261012 \
QUI56_BASELINE_DIR=/absolute/path/to/exact-current-main-checkout \
SCREENSHOT_OUTPUT=/absolute/path/to/ci-artifacts/qui56 \
bash apps/oss/tests/onboarding-v2/capture-runtime.sh
```

CI invokes the command separately with `CAPTURE_PHASES=before` and
`CAPTURE_PHASES=after`, stopping on either failure. It runs
`bunx playwright test -c playwright.runtime-captures.config.ts --workers=1`
once per before/after phase. Archive all eight before and 24 after images only
after successful assertions. Keep a failed or partial run as diagnostics rather
than accepted visual evidence. This command is recorded for CI and was not run
locally.

## PR122 CI evidence workflow

The job has only `contents: read`, disables persisted checkout credentials and
uses no production secrets. It resolves current `origin/main` once in the
revision-selection job and checks out that immutable SHA independently from the
immutable pull-request head SHA. The PR base is the stacked parent and is not
used as the visual baseline. Both checkouts install frozen dependencies and
generate their own Prisma clients. Chromium comes from the head's frozen
Playwright dependency. The same head configuration and assertions drive both
phases, with one worker, without replacing baseline production sources.

Both phases use the same disposable localhost database. Baseline migrations
are deployed first, then head migrations before capture, because the common
head fixtures select additive onboarding columns absent from main. This shared
head-migrated schema is disclosed in the manifest and does not change the
baseline application or its generated client.

Only after both capture commands exit successfully does
`scripts/check-qui56-evidence.mjs` verify all eight before and 24 after PNGs and
write the manifest with application/harness SHAs, run URL, Chromium revision,
provider and manual-save limits, and SHA-256 image hashes. The successful
artifact is named `qui56-complete-<head SHA>`. Failures or cancellations upload
only `qui56-diagnostics-only-<head SHA>`; partial images are not accepted evidence.
The GitHub run logs retain assertion and server diagnostics.

Static validation for this workflow change passes actionlint, YAML parsing,
Node syntax, existing runner shell syntax, scoped oxlint and diff whitespace
checks. No local install, server, browser, build, typecheck or full suite ran.
No new images were generated locally. CI execution and Ines approval remain
pending; historical galleries do not satisfy this head's evidence requirement.
