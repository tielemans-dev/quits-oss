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
