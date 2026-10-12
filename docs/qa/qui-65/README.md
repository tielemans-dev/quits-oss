# QUI-65 quote pages verification

## Evidence and review gates

PR #130 remains ready for review. Exact-head required CI must be green before a fresh Codex review
is requested. Ines separately gates ready-for-Kai after visual sign-off. No merge, deployment,
release or integration with #127/#131 is authorized here.

The CI `Quote evidence (before)` and `Quote evidence (after)` jobs run the real app with Chromium.
Before uses the PR base commit on main, with only the head test harness copied into that checkout.
After uses the exact PR head. `provenance.json` records both application and harness SHAs and the
workflow run URL. Production sources in the baseline are checked for changes and are never patched.
Baseline language/layout defects remain visible and are not counted as regressions in the before run.

Each phase requires 56 full-page PNGs: public pending/accepted, admin numbered/draft invoice,
quote list, activity log and locale shell. Every screen has DA/EN, light/dark and desktop 1440px/mobile
390px captures. Eight JSON files record browser/org locale, HTML language, sidebar and SSR navigation;
eight HTML files preserve the synthetic server response. The after run asserts initial Danish sidebar
markup in an English browser, matching HTML language, short list dates, and quote/credit activity copy.
All registered quote/credit events and invoice crediting are present in the activity fixture.

The completeness script checks every expected file, PNG signature/width and exact SHA provenance.
A green job produces `manifest.json`, a tar archive and an uploaded artifact retained for 30 days.
The job summary links the artifact. A failed upload may contain partial diagnostics; it is not complete
evidence. Artifact links and CI status in the PR must be refreshed for the final head.

## CI-only execution

No local browser, dev server, build, typecheck or full suite is allowed for this task. The authorized
local checks are targeted Vitest regressions serialized through Fleet with one worker and a worktree
TMPDIR. Full lint/typecheck/tests/i18n/build/boundary/browser verification runs in GitHub CI.

Capture mode requires CI, an explicit `QUI65_CAPTURE_DIR`, and the dedicated disposable localhost
`qui65` database. MOCK fixtures comprise synthetic quotes, invoices, contacts and activity events.
They exist only in tests, never in production imports or real customer databases.

## Integration hot spots

Kai owns integration with #127's activity/date helpers and #131's approved public quote amount
renderer. This branch does not merge those branches or rewrite VAT totals. Mira's copy stays verbatim.
English short dates use day-first order; other configured locales retain their own month names.
Public issue/decision instants retain document timezone semantics; calendar expiry dates use UTC.
No migrations or public package-export changes are included.
