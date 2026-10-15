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
eight HTML files preserve the synthetic server response. JSON records both the raw response
`serverHtmlLang` and hydrated `htmlLang`; after evidence requires both to match the organization. The after run asserts initial Danish sidebar
markup in an English browser, matching HTML language, short list dates, and quote/credit activity copy.
No-organization onboarding also checks the English SSR fallback and Danish browser detection after
hydration. Fixed public documents retain their own language wrapper. All registered quote/credit events and invoice crediting are present in the activity fixture.

The completeness script checks every expected file, PNG signature/width and exact SHA provenance.
A green job produces `manifest.json`, a tar archive and an uploaded artifact retained for 30 days.
The job summary links the artifact. A failed upload may contain partial diagnostics; it is not complete
evidence. Artifact links and CI status in the PR must be refreshed for the final head.

## Prior evidence provenance

[Run 38255955430](https://github.com/tielemans-dev/quits-oss/actions/runs/38255955430) used harness
head `821660e0795fcc71a4b25864429382549d5f30a8`. Its verify/browser smoke and both quote evidence
jobs failed at the public acceptance assertion, before a complete matrix was captured. The
[before artifact](https://github.com/tielemans-dev/quits-oss/actions/runs/38255955430/artifacts/11749563576)
and [after artifact](https://github.com/tielemans-dev/quits-oss/actions/runs/38255955430/artifacts/11749907973)
are partial diagnostics for that prior head, not final validation or visual approval. Earlier green
CI at `6c08b81` also does not validate the SSR follow-up. Final-head links and status belong in the PR;
the parent owns monitoring and Ines owns separate visual sign-off.

## Acceptance fixture repair

Both prior before/after traces show the real accept POST returning HTTP 200 with `kind: invalid`,
then the invalid-link page. The fixture inserted 11 events using `max(sequence) + 1` but left
`orgSettings.eventSequence` unchanged. The real customer-decision command appends its accepted
event through that counter, so its transaction collides with the fixture's unique event sequence.
PostgreSQL teardown logs confirm `domain_event_organizationId_sequence_key` collisions at sequence
1 in both phases. Main baseline `4931661dd7e53d83555590e06a2e2cf97448743b` and head use the same
allocator.

The harness now reserves fixture sequence numbers by advancing that counter within the same
transaction as the synthetic inserts. Every real accept click still requires the exact DA/EN
accepted title, and additionally checks HTTP success, persisted accepted state/decision instant,
the next `quote.accepted` event with customer source, and the advanced counter. This runs in both
phases without patching baseline production sources. The startup Nitro SSR-environment 503 precedes
successful login/document requests in both traces; it is distinct from the HTTP 200 invalid decision.
CI validates the repair; no local browser or server is used.

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
