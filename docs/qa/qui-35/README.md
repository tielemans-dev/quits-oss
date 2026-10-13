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

The existing quantity contract accepts positive decimal-point strings up to six
places and at most 1000000. Comma input remains unsupported, with an explicit
localized explanation. The regression verifies exponent and other invalid
strings make no save request, then verifies `0.123456` survives save/reload and
`1.5` creates a draft.

This branch starts at fetched OSS main `38a26531`. Main still has inline invoice
editors. PR #132 introduces `lines-editor.tsx` and replaces those sections.
After #132 lands, rebase this PR and apply the raw text quantity input,
quantity-schema validation, textarea wrapping, and VAT-label wrapping to that
editor. Do not restore the inline editor or overwrite #132's send-flow changes.
Rerun the regression and refresh screenshots if that integration changes the UI.

Ines approval and Codex review are still required. This PR remains a draft;
passing local checks alone does not make it ready for Kai.

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
