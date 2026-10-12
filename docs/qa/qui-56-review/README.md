# QUI-56 review evidence

The saved-default form captures use implementation head `9bc6e5051cf8cfb2779756af622ccd4899916486`. The production PDF evidence includes the subsequent future non-VAT CVR-label fix in this commit. The before/main baseline is `808debcfc95a1a5cf8cd782895e40e6e999baa85`. This evidence uses actual application forms, authenticated sessions and a disposable local synthetic database, `qui56_review_5492172888`. No production data, email or hosted provisioning is used.

## Ines shot list

Before/main and after new invoice and new quote, with VAT rate prefilled from saved settings, Danish and English, light and dark, desktop and 390px. Also one non-VAT seller with 0% lines and an invoice PDF showing `CVR-nr.` and the approved non-VAT statement. Ines approval is required before readiness for Kai.

## Completed before/main captures

The saved organization rate is 25%. On main, the new invoice and quote forms initialize to 0%. The real browser assertion verified 0% before each capture. All 16 before/main combinations passed with one Playwright worker through Fleet.

- [invoices, da, light, desktop](before-invoices-da-light-desktop.png)
- [invoices, da, light, mobile](before-invoices-da-light-mobile.png)
- [invoices, da, dark, desktop](before-invoices-da-dark-desktop.png)
- [invoices, da, dark, mobile](before-invoices-da-dark-mobile.png)
- [invoices, en, light, desktop](before-invoices-en-light-desktop.png)
- [invoices, en, light, mobile](before-invoices-en-light-mobile.png)
- [invoices, en, dark, desktop](before-invoices-en-dark-desktop.png)
- [invoices, en, dark, mobile](before-invoices-en-dark-mobile.png)
- [quotes, da, light, desktop](before-quotes-da-light-desktop.png)
- [quotes, da, light, mobile](before-quotes-da-light-mobile.png)
- [quotes, da, dark, desktop](before-quotes-da-dark-desktop.png)
- [quotes, da, dark, mobile](before-quotes-da-dark-mobile.png)
- [quotes, en, light, desktop](before-quotes-en-light-desktop.png)
- [quotes, en, light, mobile](before-quotes-en-light-mobile.png)
- [quotes, en, dark, desktop](before-quotes-en-dark-desktop.png)
- [quotes, en, dark, mobile](before-quotes-en-dark-mobile.png)

At 390px the existing form overflows horizontally and clips its VAT summary. The full-page mobile captures are partial visual evidence. The after captures below include eight supplemental viewport screenshots with the real VAT input scrolled into view. No responsive product change is included in this task.

## Completed after captures

Saved organization settings contain 25%. All 16 actual new-invoice/new-quote combinations passed a browser assertion that the VAT input is 25% before capture. Authentication, active organization selection, settings queries and forms are real. No mocked onboarding UI is used.

- [invoices, da, light, desktop](after-invoices-da-light-desktop.png)
- [invoices, da, light, mobile](after-invoices-da-light-mobile.png)
- [invoices, da, dark, desktop](after-invoices-da-dark-desktop.png)
- [invoices, da, dark, mobile](after-invoices-da-dark-mobile.png)
- [invoices, en, light, desktop](after-invoices-en-light-desktop.png)
- [invoices, en, light, mobile](after-invoices-en-light-mobile.png)
- [invoices, en, dark, desktop](after-invoices-en-dark-desktop.png)
- [invoices, en, dark, mobile](after-invoices-en-dark-mobile.png)
- [quotes, da, light, desktop](after-quotes-da-light-desktop.png)
- [quotes, da, light, mobile](after-quotes-da-light-mobile.png)
- [quotes, da, dark, desktop](after-quotes-da-dark-desktop.png)
- [quotes, da, dark, mobile](after-quotes-da-dark-mobile.png)
- [quotes, en, light, desktop](after-quotes-en-light-desktop.png)
- [quotes, en, light, mobile](after-quotes-en-light-mobile.png)
- [quotes, en, dark, desktop](after-quotes-en-dark-desktop.png)
- [quotes, en, dark, mobile](after-quotes-en-dark-mobile.png)

Supplemental VAT inputs at 390px:

- [invoices, da, light, VAT input](after-invoices-da-light-mobile-rate.png)
- [invoices, da, dark, VAT input](after-invoices-da-dark-mobile-rate.png)
- [invoices, en, light, VAT input](after-invoices-en-light-mobile-rate.png)
- [invoices, en, dark, VAT input](after-invoices-en-dark-mobile-rate.png)
- [quotes, da, light, VAT input](after-quotes-da-light-mobile-rate.png)
- [quotes, da, dark, VAT input](after-quotes-da-dark-mobile-rate.png)
- [quotes, en, light, VAT input](after-quotes-en-light-mobile-rate.png)
- [quotes, en, dark, VAT input](after-quotes-en-dark-mobile-rate.png)

## Completed non-VAT PDF evidence

The synthetic self-host seller has `momsRegistered: false`, saved VAT 0%, CVR `12345678`, and a real draft whose persisted line tax rates are all zero. The [new invoice form](after-nonvat-invoice-da-light-desktop.png) passed a 0% browser assertion. Both PDFs came from the authenticated application endpoint using the production renderer, returned HTTP 200 with `application/pdf` and a valid PDF header. The Danish response was also asserted to use the live draft artifact.

- [Danish PDF](synthetic-nonvat-invoice-da.pdf) and [rendered page](synthetic-nonvat-invoice-da-pdf.png) show `CVR-nr.: 12345678` and "Der er ikke beregnet moms, da sælger ikke er momsregistreret."
- [English PDF](synthetic-nonvat-invoice-en.pdf) and [rendered page](synthetic-nonvat-invoice-en-pdf.png) show `CVR no.: 12345678` and "No VAT charged – the seller is not VAT-registered."

PDF text extraction asserted both exact approved statements and the Danish identifier label. Both rendered pages were visually inspected. The label is frozen in future non-VAT invoice render inputs; historical inputs without that field retain `CVR:`. Stored issued artifacts are not rewritten. Hosted `onboardingV2.nonVatEnabled` remains off until QUI-62.

## Capture diagnosis

Own frozen dependencies resolved the earlier client-entry 404. The successful saved-default run waits for the actual VAT input rather than network idle. The non-VAT fixture initially used an insufficient five-second hydration wait; the same 30-second assertion as the saved-default capture passed. It then exposed the production `CVR:` label mismatch, which the narrowly scoped frozen-label fix corrected. The final non-VAT browser/PDF run passed.

All heavy commands ran sequentially through Fleet with one worker. The queue was never bypassed, and no unrelated server was stopped. All servers started for these captures and their Fleet commands exited.

## Onboarding step and manual-entry ownership

Current main was verified as `21065ada03ec0274a013ee335dde15cb6ef3677d`, already an ancestor of this branch. No new merge was needed. The earlier saved-default before captures use the documented `808debcf` baseline; they are not new current-main onboarding captures.

The v2 onboarding components, step flow and manual entry belong to stacked PR #122, branch `qui-56-screens`, inspected at `ad07867326c857db5f558a06e5c2ac57e3d403e4`, based on `qui-56-confirm-v2`. This T2 checkout has no `src/components/onboarding-v2` directory. Actual current-main/after onboarding-step screenshots, including manual entry, must be completed by a fresh #122 maintenance child after #121 is green. Existing T3 images were not changed or copied, and the T3 feature was not added to T2. Ines remains the approval gate.

## CI diagnosis at the incoming head

At `9bc6e505`, push run `38294180510` shared-browser job `114961178366` failed before app tests: pulling the pinned PostgreSQL image from ECR returned `toomanyrequests: Rate exceeded`. Pull-request twin run `38294186306` shared-browser job `114961197929` passed at the identical head. Both OSS-boundary jobs passed. Both verify jobs remained active at the last inspection.

One infrastructure retry submission was refused by GitHub with `job 114961178366 cannot be rerun` while its parent run remained active. No retry actually started. The new published head still requires its own green CI; old-head passes do not establish that.

## Verification

123 blocker regressions and 74 focused calendar/PDF/hook/runtime tests passed against this worktree's own frozen dependencies on a dedicated disposable database. The inherited-dependency run is excluded. Workspace lint and typecheck, i18n, 26 boundary regressions, the boundary scan and whitespace checks passed for the corrected implementation. The preserved full-suite run exited without a final summary; it is not a full-suite pass. This continuation also passed 36 focused PDF/issuance/legal-field tests, lint, whole-app typecheck, i18n, 26 boundary cases and the boundary scan against its own dependencies. No additional full suite or build was started.

Test-only billing/session/settings mocks remain labelled in regression tests. The completed browser captures use real auth, database settings and application forms. Production PDF rendering and artifact storage remain real in the earlier issuance regressions.

## Preserved behavior and copy

Legacy save/complete/manual paths retain serialized guards. Future PDF registration declarations use the approved copy consistently, while existing issued UBL/PDF artifacts remain frozen. Registry-sourced contact values are scrubbed on the server because client protection metadata is not trusted. Saved payment terms initialize the due date without overwriting user calendar edits. The existing migration is retained; no second migration is added.

Mira approved the exact copy in `COPY.md`: DA "Der er ikke beregnet moms, da sælger ikke er momsregistreret." and EN "No VAT charged – the seller is not VAT-registered." Validation keys include `cvr.invalid` and `save.failed`.

Local capture scripts and logs are preserved in `.verify-qui56/`. Kai owns Linear coordination. No Linear calls or bot review comments were made. New-head CI, actual #122 onboarding/manual-entry evidence and Ines approval remain outstanding. #122 maintenance stays with the parent after #121 is green. This work does not claim readiness for Kai.

## Review 5495265870 blockers

This pass starts from exact head `c7db767023288a8c99fd2494078026a020bfc4e7` and addresses findings 4251714026, 4251714032, 4251714038 and 4251714045.

- AI settings and identifier writes now share one transaction and the v2 organization/settings lock order. Completed v2 organizations reject stale AI patches with `CONFLICT`. PostgreSQL barriers cover both race orders, including confirmation waiting for the AI identifier write.
- The published defaults resolve the year at use time in `Europe/Copenhagen`, including a running server crossing midnight on New Year's Eve. Confirmation uses one defaults snapshot and preserves existing prefixes/counters under the settings lock. It never lowers an existing invoice counter.
- A missing seller tax identifier is exempted only for non-VAT sellers whose nonempty frozen v2 groups are all `out_of_scope`. Zero-rated and exempt groups, and legacy zero-rate documents, still require the identifier. Nominal line rates cannot override frozen classifications.
- Confirmation rejects numbered invoice/quote drafts as history. A real legacy `QTE-0001` draft regression verifies the existing book remains intact, sending the legacy quote preserves its number, and the next quote issues as `QTE-0002`.

The primary [Peppol CompanyID specification](https://docs.peppol.eu/poacc/billing/3.0/syntax/ubl-invoice/cac-AccountingSupplierParty/cac-Party/cac-PartyTaxScheme/cbc-CompanyID/) was checked on 2026-10-12. BR-Z-02 and BR-E-02 require a seller VAT, tax-registration or tax-representative identifier for Z/E; BR-O-02 prohibits VAT identifiers for O. This patch narrows the application's exemption, without rewriting issued artifacts or changing Mira's approved copy.

Hosted non-VAT remains disabled without an explicit runtime opt-in until QUI-62. Self-host settings remain configurable. No migration, T3 worktree, onboarding step UI, or existing capture was changed. Ines approval remains required.

The focused run passed all 142 tests. After correcting two export fixture types, the final Fleet run passed 67 export tests, all 3,649 workspace tests, workspace lint and whole-app typecheck, i18n checks, all 26 OSS boundary regressions, the boundary scan and whitespace checks. The full app run includes all 38 confirmation tests and the real 60-second expiry case. No skipped database suite or earlier failed invocation is counted as a pass.

Both browser checks passed with one worker: saved 25% invoice/quote defaults across DA/EN, light/dark and desktop/mobile, and the self-host 0% invoice form plus actual DA/EN production PDF endpoints. The PDFs retain the approved non-VAT copy and CVR labels. New verification outputs are local in `.verify-qui56/new-blockers-captures/`; the existing committed before/after screenshots and PDFs are unchanged. Logs are preserved in `.verify-qui56/new-blockers-corrected.log` and `.verify-qui56/new-blockers-final.log`. All heavy commands used Fleet sequentially with one test worker, waited for existing jobs, and exited. No unrelated job was interrupted.

This commit still requires CI on its published head and a fresh parent review. The active #122 child must integrate the new #121 head through its parent; this pass did not edit its worktree or reuse earlier children. Kai owns any Codex review request after the fixed head is green. No bot review request was sent, and Ines remains the approval gate.
