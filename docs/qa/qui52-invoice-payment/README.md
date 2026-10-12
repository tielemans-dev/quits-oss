# QUI-52 invoice payment review

The rework uses Mira's final “Betalingsbesked / Payment message” copy. The row value is the trimmed stored payment reference, falling back to the invoice number when the reference is absent or blank. The guard against “Betalingsreference” remains in unit and browser tests.

The 16 historical after captures at `4b47188a96620b248dbd5ddcdeeb7af059f5daf6` cover received email and the authenticated invoice page in DA/EN, light/dark, desktop 1440×1000 and mobile 390×844. Email HTML comes from an actual UI resend through disposable Mailpit. Both capture tests passed, including bounds checks for every visible invoice action at 390px. Full-page image height can exceed viewport height.

The frozen synthetic seller is Issue-time Seller ApS, Testvej 42, 9000 Aalborg, CVR 12345678, reg 0040 and account 0440116243. The invoice is INV-0042, amount 250.00 DKK or USD, issued/supplied 9 March 2026 and due 23 March 2026. Live organization settings deliberately have different seller, address, bank and note values. The PDF renderer and artifact store are test-only in-memory adapters. No production data or production mocks are used.

[Before provenance](before-manifest.json) preserves the supplied eight light-theme origin/main captures at `4931661dd7e53d83555590e06a2e2cf97448743b`. [After provenance](after-manifest.json) records the rework code at `4b47188a96620b248dbd5ddcdeeb7af059f5daf6`, pixel dimensions and SHA256 hashes.

The eight missing before-dark captures are now included with [provenance and SHA256 hashes](before-dark-manifest.json). [GitHub CI run 38253320209](https://github.com/tielemans-dev/quits-oss/actions/runs/38253320209) passed both locale capture scenarios with one worker. [Download the original artifact](https://github.com/tielemans-dev/quits-oss/actions/runs/38253320209/artifacts/11748558987). All 32 committed screenshots have verified hashes and pixel dimensions.

This is the true pinned main UI at `4931661dd7e53d83555590e06a2e2cf97448743b`, with no tracked baseline runtime changes. Only the PR's opt-in capture fixture and CI runner were copied into that checkout from `5ff4896954e5f20fbdcfda9e869b465124353169`. Dark captures use the app's dark theme and Chromium's dark color preference. Main's delivered email retains its original light styling under that preference; no CSS or reference screenshot was substituted. The main mobile layout predates the action bounds fix, so the baseline path skips that after-only assertion and records the existing overflow. The ordinary after capture still checks mobile bounds. Desktop is 1440×1000; mobile is 390×844; all screenshots are full-page.

MOCK/TODO: synthetic seller/customer/invoice/bank details, deterministic historical invoice dates and number, in-memory PDF renderer/artifact store, disposable PostgreSQL and Mailpit. These test fixtures do not establish real PDF rendering. No production mocks, data or services are used. All new browser/build work ran in GitHub CI; local verification was script syntax and evidence hashes only. The missing `designs/pay-da-bank-only-desktop.png` was also unavailable in this checkout; the supplied design and final copy comments guided this rework. Ines must sign off before the draft can be ready for Martin.

| Screen | Locale | Viewport | Before, main light | Before, main dark preference | After light | After dark |
| --- | --- | --- | --- | --- | --- | --- |
| Email | DA | desktop | [Before](before/email-da-desktop.png) | [Before dark](before/dark/email-da-desktop.png) | [After](after/light/email-da-desktop.png) | [After](after/dark/email-da-desktop.png) |
| Email | DA | mobile | [Before](before/email-da-mobile.png) | [Before dark](before/dark/email-da-mobile.png) | [After](after/light/email-da-mobile.png) | [After](after/dark/email-da-mobile.png) |
| Email | EN | desktop | [Before](before/email-en-desktop.png) | [Before dark](before/dark/email-en-desktop.png) | [After](after/light/email-en-desktop.png) | [After](after/dark/email-en-desktop.png) |
| Email | EN | mobile | [Before](before/email-en-mobile.png) | [Before dark](before/dark/email-en-mobile.png) | [After](after/light/email-en-mobile.png) | [After](after/dark/email-en-mobile.png) |
| Invoice | DA | desktop | [Before](before/invoice-da-desktop.png) | [Before dark](before/dark/invoice-da-desktop.png) | [After](after/light/invoice-da-desktop.png) | [After](after/dark/invoice-da-desktop.png) |
| Invoice | DA | mobile | [Before](before/invoice-da-mobile.png) | [Before dark](before/dark/invoice-da-mobile.png) | [After](after/light/invoice-da-mobile.png) | [After](after/dark/invoice-da-mobile.png) |
| Invoice | EN | desktop | [Before](before/invoice-en-desktop.png) | [Before dark](before/dark/invoice-en-desktop.png) | [After](after/light/invoice-en-desktop.png) | [After](after/dark/invoice-en-desktop.png) |
| Invoice | EN | mobile | [Before](before/invoice-en-mobile.png) | [Before dark](before/dark/invoice-en-mobile.png) | [After](after/light/invoice-en-mobile.png) | [After](after/dark/invoice-en-mobile.png) |

## Validation and overlap

The targeted email-render test passed with one worker and a worktree-local TMPDIR. Earlier focused unit checks, i18n and boundary checks passed. Local full typecheck/builds were interrupted by host memory cleanup; do not treat those as passing. The starting head `114f5b158e15a30e5400c2a53cbbe47d1343e643` passed all six push/PR CI jobs. New evidence commits rerun full verification in GitHub CI; the PR Validation section records the final exact head and results. `bun run test` includes `i18n:check`.

All six failed jobs on `1aae479` were inspected across push and PR workflows. Unit failures were stale email CVR and short-month expectations; the browser failure was the old inline due-date label and long date expectation. The browser artifact confirms `Due Date` and `15 Nov 2026`; all eight QUI-52 browser regressions passed. The bounded expectation fix passed 23 tests across the Danish invoice, settings localization and email payment files with one worker and a worktree-local TMPDIR. PDF date and frozen-identity assertions remain intact. The shared browser scenario passed a syntax check; its full rerun belongs in CI.

QUI-61 PR #127 overlaps `lib/i18n/format.ts`, `lib/email.ts`, `lib/documents/invoice-identity.ts`, the invoice route and the shared Danish-field tests. QUI-52 extends the existing formatter with an opt-in day-first order and explicitly requests short months. It leaves the global month default to QUI-61. QUI-61’s explicit long invoice-email dates conflict with this final brief and must yield to these short invoice-email dates when the branches are integrated.

The app/payment block uses `CVR-nr.` while other document callers retain their current CVR label through an optional argument. Account grouping is display-only, `0440 116 243`, preserving all stored digits and leading zeros.

Browser regression: [invoice-payment-block.spec.ts](../../../apps/oss/tests/shared/invoice-payment-block.spec.ts). Opt-in capture fixture: [invoice-payment-capture.spec.ts](../../../apps/oss/tests/shared/invoice-payment-capture.spec.ts). The capture fixture requires `QUI52_CAPTURE_OUTPUT`, a local `QUI52_MAILPIT_URL`, SMTP configuration and the guarded disposable shared environment. `QUI52_CHROMIUM` can select an installed executable.

## Bounded GitHub review fixes after 2bd7796

The four review findings are addressed by sharing the existing bank-field formatter (including IBAN/BIC), showing current outstanding only in payment instructions, hiding the draft payment block, and removing the remote email font. Original invoice totals, issued seller identity and PDF/artifact storage remain unchanged. Resend already accepts sent/overdue invoices with partial settlement; settled invoices still cannot be resent. Tests cover settled rendering through the composer and authenticated page without changing that guard.

New regressions run real send/resend, payment and credit commands with synthetic accounts. Shared browser scenarios cover IBAN-only issued email/page, draft settings changes, issued immutability, partial payment/credit and full settlement. Existing copy, date, account grouping and mobile assertions remain. All added data and provider/PDF adapters are test-only MOCK fixtures. No migrations were added.

The 32 screenshots above describe their recorded earlier code heads. The current-head capture workflow produces eight draft-page images after seller settings changes in DA/EN, light/dark, desktop 1440×1000 and mobile 390×844. Its manifest records the exact pushed SHA, dimensions and hashes. It runs in CI with one worker and a worktree-local TMPDIR. These captures verify hidden draft seller/payment blocks; they do not show issued payment instructions or received email. Mailpit is configured in the disposable environment, but the current draft-only scenario does not issue or resend an invoice.

Starting head `c35017bbf0834261f0623cc4f55654ba9439862b` passed both CI verify jobs, both shared-browser jobs, both OSS boundary jobs and [draft capture run 38265333698](https://github.com/tielemans-dev/quits-oss/actions/runs/38265333698). The parent reported all eight draft image hashes/dimensions verified, four payment-less email screenshots verified, and all 12 locale/theme/bank variants green. The shared browser scenario attaches composed issued email HTML in both locales and themes, including payment-less variants. Those screenshots use synthetic data and are browser-rendering evidence, not Mailpit delivery evidence.

The bounded follow-up preserves stored custom payment references in email/detail, with a trimmed invoice-number fallback. Compact dates retain Intl calendar parts and locale notation outside Danish/English Gregorian formatting, including the Japanese era. Focused unit regressions and the existing shared browser reference assertions cover these changes. The starting-head evidence does not validate this follow-up; exact-head checks and refreshed evidence remain pending in CI. No local runtime checks were run because no parent Fleet slot was supplied.

The parent owns final verification and review. The missing `designs/pay-da-bank-only-desktop.png` and Ines's design sign-off remain unresolved. Kai owns #127 integration. Capture duplication remains deferred.
