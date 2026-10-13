# QUI-35 invoice editor evidence

The PNGs show the actual OSS invoice editor in Chromium at 390 × 844 CSS pixels,
light theme, in Danish and English. They are full-page screenshots from
`apps/oss/tests/e2e/invoice-editor-qui35.spec.ts`.

The organization, customer, invoice, and long English description are synthetic
fixtures in an owned disposable PostgreSQL database. The editor, auth endpoints,
translations, pricing preview, and save requests are real application code.
There are no UI adapters, intercepted API responses, or DOM substitutions.
The screenshots retain `1e3` and show its localized rejection, with long prose
and an unbroken reference wrapping in both the editable line and its VAT card.

The API quantity contract accepts positive decimal-point strings up to six
places and at most 1,000,000. The editor now accepts a decimal comma as well,
retains raw text while editing, and normalizes valid quantities for previews and
create/edit requests. Mixed separators and grouping are rejected. The browser
regression uses `0,123456` for Danish edit/save/reload and `1,5` for Danish create;
English still exercises decimal-point input. Stored quantities remain canonical.

This branch starts at fetched OSS main `38a26531`. Main still has inline invoice
editors. PR #132 introduces `lines-editor.tsx` and replaces those sections.
After #132 lands, rebase this PR and apply the raw text quantity input,
quantity-schema validation, textarea wrapping, mobile-visible accessible quantity,
unit-price and total labels, and VAT-label wrapping to that
editor. Do not restore the inline editor or overwrite #132's send-flow changes.
Rerun the regression and refresh screenshots if that integration changes the UI.

PR #148 is open and ready for review. Codex reviewed `cc897343` without major
findings, but Ines's quantity blocker remains. The repair needs new-head CI and
review; passing local checks alone does not make it ready for Kai.

## Focused quantity repair, 2026-10-13

This round addresses comma input only. Description wrapping and mobile labels
were approved by Ines. VAT rate/country labels remain outside this round.
Fetched main `8a8c7594` has no overlapping invoice-editor changes. PR #132 is
still open; its new editor must preserve comma normalization on integration.

No Mira-approved replacement quantity error was found in the complete QUI-35
issue, its comments, PR #148's comments/review threads, or the catalog. The
existing error text is unchanged pending Kai/Mira's exact DA/EN copy. Ines's
requested Danish `1.000.000` formatting belongs in that approved copy.

Local verification for this repair passed: 30 quantity normalization, preview,
create/edit schema tests; 44 focused contract tests; changed-file lint; catalog
and translation-memory checks; 26 boundary regression cases and the boundary
check; and diff whitespace checks. Tests ran one at a time through Fleet with
one worker. The browser spec was updated but not run locally in this round.

The captures above predate comma support. Parent owns the coordinated screenshot
round and Ines sign-off, including current-main before/after, DA/EN, 390/1440,
light and requested dark coverage. Refresh the DA captures after #132 integration.
Full lint, typecheck, unit/integration/browser suites, build, i18n and
`verify-oss-boundary` must pass in new-head CI before review coordination.

## Verification

- Targeted `test:e2e` spec: 2 passed, Danish and English, Chromium, one worker.
- Changed-file oxlint: no warnings or errors.
- `bun run i18n:check`: passed, both catalogs and translation-memory guard.
- OSS `bun run typecheck`: passed, quality and application projects.
- Targeted shared pricing tests: 37 passed across `pricing.test.ts` and
  `activation.test.ts`, one worker.
- `git diff --check`: passed.

Local runs used one outer `fleet-heavy` job at a time. Browser startup and
verification used a temporary runner with the repository's disposable harness,
an ESM Vite config that prevents loading checkout environment files, and a
Playwright config selecting only this regression. None of those temporary
configs or adapters ship in the product or change CI. The harness stopped its
owned app process and disposable database in `finally`, and Fleet was released.
Full lint, test suites, and builds are left to CI as requested.

Early local attempts exposed a temporary Vite module-mode error, a missing Origin
header in test authentication, an early save-completion assertion, and an invalid
legacy VAT fixture. The final test uses explicit auth organization selection and
valid synthetic VAT data. No auth/VAT behavior fixes were added.

## CI locator follow-up

Run `38323120524`, job `115055531422`, built successfully but failed the
three shared invoice create/edit/PDF scenarios. Their quantity/price locators
assumed two spinbuttons per line. Quantity is now deliberately a text input.
The shared scenarios now use the existing `Qty` label and the single unit-price
spinbutton scoped to its description row. The invoice paths in the pricing
browser spec use the same selectors; quote and recurring selectors stay unchanged.
Raw quantity validation and the committed DA/EN screenshots are unchanged.

Changed-file oxlint and `git diff --check` passed. Local browser attempts used
one outer Fleet job and one worker with the disposable harness. The documented
production harness build exited with SIGTERM under high memory pressure.
Dev-server shared scenarios first timed out during login. With a temporary
navigation-readiness fixture, edit completed successfully, but create timed out
waiting for client readiness on `/invoices/new`. The remaining run was stopped
when memory pressure rose again. This does not establish a passing create/PDF
run or a passing pricing browser run. CI must confirm them. Owned servers and
disposable containers were stopped and Fleet was released after each attempt.

## Mobile-label repair at the reviewed head

The Codex P2 finding on `ef5e2f62540735d5aff105daee00112405556b3f`
[identified missing mobile labels](https://github.com/tielemans-dev/quits-oss/pull/148#discussion_r4253987992).
Both existing inline invoice editors now pair quantity and unit price with native
labels linked by `htmlFor`, and name the computed total output through
`aria-labelledby`. Labels are visible below `md`; desktop keeps the shared header.
Copy comes from the existing DA/EN catalog: Antal/Qty, Enhedspris/Unit Price, Total.
No quantity validation, wrapping, shared selector repair, or other flow changed.

The refreshed DA/EN edit PNGs show all three labels at 390 × 844, with the same
synthetic fixture and real app paths documented above. They are edit evidence;
there is no new English-create evidence or desktop evidence. No baseline was
captured. The regression asserts visible associated labels in both edit and new.

Repair verification:

- Changed-file oxlint, application/quality typecheck, catalog and translation-memory
  checks passed. Shared pricing tests passed: 37, one worker. Diff check passed.
- Corrected targeted browser run: Danish passed the full create/edit regression.
  English passed edit label, wrapping, invalid-input and persistence checks, then
  Chromium crashed during `/invoices/new` navigation readiness. Result: 1 passed,
  1 failed. This does not certify English create on the new head.
- An initial run failed because the new test helper referenced an out-of-scope
  quantity locator. That helper was corrected before the final run.
- Runs used one outer Fleet job at a time and one browser/test worker. Memory and
  I/O pressure rose during browser work. No further cold browser run or local
  build was attempted. Full lint, unit/integration/browser suites and build are
  left to CI; the parent owns CI watching and the next review request.
- The owned Vite server and disposable PostgreSQL container were stopped by the
  harness `finally`; Fleet was released. No VPS/#132 branch or code was touched.

Keep this PR draft pending current-head CI, Codex review, and Ines approval.
After #132 integration, preserve these labels alongside the original QUI-35
wrapping and raw quantity validation, then rerun the regression and evidence.
