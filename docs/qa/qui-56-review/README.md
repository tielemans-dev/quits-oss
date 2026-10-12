# QUI-56 review evidence

The implementation head is `512df1f4134e87ce6fdf14342ca65436a732c147`. The before/main baseline is `808debcfc95a1a5cf8cd782895e40e6e999baa85`. This evidence uses actual application forms, authenticated sessions and a disposable local synthetic database, `qui56_review_5492172888`. No production data, email or hosted provisioning is used.

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

At 390px the existing form overflows horizontally and clips its VAT summary. These full-page mobile captures are partial visual evidence; supplemental captures with the real VAT input scrolled into view are still required. No responsive product change is included in this task.

## Remaining capture blocker

The original client-entry HTTP 404 was resolved by installing the baseline's own frozen dependencies. Selecting the seeded organization through the real auth API was also required. The after run reached the application but timed out waiting for network idle under host memory/I/O pressure. It produced no after captures. The local capture script now asserts the real VAT input directly instead of waiting for network idle.

At handoff, the shared Fleet queue is held by a persistent `pnpm exec vite dev --port 3006 --host 127.0.0.1` server in `/home/mpt/Projects/quits/cloud-landing-nav-fix`. That unrelated process was not stopped. After captures, supplemental mobile captures, and the non-VAT PDF remain incomplete. Do not treat the available before images as a completed comparison.

The prepared non-VAT fixture uses self-host configuration, `momsRegistered: false`, 0% draft lines and a synthetic CVR. It requests the authenticated application PDF endpoint backed by the production renderer. It has not run successfully and supplies no PDF evidence yet. Hosted `onboardingV2.nonVatEnabled` stays false until QUI-62 lands.

## Verification

123 blocker regressions and 74 focused calendar/PDF/hook/runtime tests passed against this worktree's own frozen dependencies on a dedicated disposable database. The inherited-dependency run is excluded. Workspace lint and typecheck, i18n, 26 boundary regressions, the boundary scan and whitespace checks passed for the corrected implementation. The preserved full-suite run exited without a final summary; it is not a full-suite pass. No additional full suite or build was started.

Test-only billing/session/settings mocks remain labelled in regression tests. The completed browser captures use real auth, database settings and application forms. Production PDF rendering and artifact storage remain real in the earlier issuance regressions.

## Preserved behavior and copy

Legacy save/complete/manual paths retain serialized guards. Future PDF registration declarations use the approved copy consistently, while existing issued UBL/PDF artifacts remain frozen. Registry-sourced contact values are scrubbed on the server because client protection metadata is not trusted. Saved payment terms initialize the due date without overwriting user calendar edits. The existing migration is retained; no second migration is added.

Mira approved the exact copy in `COPY.md`: DA "Der er ikke beregnet moms, da sælger ikke er momsregistreret." and EN "No VAT charged – the seller is not VAT-registered." Validation keys include `cvr.invalid` and `save.failed`.

Local capture scripts and logs are preserved in `.verify-qui56/`. Kai owns Linear coordination. No Linear calls or bot review comments were made. New-head CI and Ines approval remain outstanding. #122 integration stays with the parent after green CI.
