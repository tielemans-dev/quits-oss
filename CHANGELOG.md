# Changelog

## Unreleased

## [0.16.2](https://github.com/tielemans-dev/quits-oss/releases/tag/v0.16.2)

Changes since the published v0.16.1 tag, covering 2 merged PRs.

- Create an e-invoice (UBL) for Danish sellers who are not VAT-registered, marked as exempt under momsloven § 71 e.
- Explain why an issued invoice has no e-invoice, in the interface language.
- Reload a page by itself when a deploy replaced its built files before the app started.

See the [release notes](docs/releases/v0.16.2.md) for upgrade notes.

[Compare with v0.16.1](https://github.com/tielemans-dev/quits-oss/compare/v0.16.1...v0.16.2).

## [0.16.1](https://github.com/tielemans-dev/quits-oss/releases/tag/v0.16.1)

Changes since the published v0.16.0 tag, covering 4 merged PRs.

- Let a second CVR lookup on the new-customer form replace the name the first one filled in.
- Warn when the CVR lookup finds a company that is no longer active.
- Name the customer's missing details when sending an invoice fails, with a link to edit the customer.
- Stop a blank new invoice warning about an unsupported currency before settings load.

See the [release notes](docs/releases/v0.16.1.md) for upgrade notes.

[Compare with v0.16.0](https://github.com/tielemans-dev/quits-oss/compare/v0.16.0...v0.16.1).

## [0.16.0](https://github.com/tielemans-dev/quits-oss/releases/tag/v0.16.0)

Changes since the published v0.15.0 tag, covering 25 merged PRs.

- Attach the issued PDF to invoice and credit-note emails, and mark draft invoice and quote PDFs as not valid on every page.
- Record refunds when more has been paid than an invoice charges, and show money owed back to customers on the invoice and on Overblik. Adds one database migration.
- Keep invoice and credit-note prefixes distinct, stop onboarding rewinding counters, and date converted quotes by payment terms.
- Print a Danish buyer's CVR from the contact's tax ID field. Hosts can require a buyer CVR with `requireBuyerCvr`.
- Pick or add the customer from the invoice form, with a CVR search where the runtime has one.
- State the VAT side of every agreement amount, and show progress while creating draft invoices.
- Simplify onboarding and signup: VAT fields only for VAT sellers, real steps only, no placeholder CVR contacts, and bank details saved inline on the first send.
- Separate unit and integration tests so unit runs never touch a real database.

See the [release notes](docs/releases/v0.16.0.md) for upgrade notes.

[Compare with v0.15.0](https://github.com/tielemans-dev/quits-oss/compare/v0.15.0...v0.16.0).

## [0.15.0](https://github.com/tielemans-dev/quits-oss/releases/tag/v0.15.0)

Changes since the published v0.14.0 tag, covering 36 merged PRs.

- Explain why Send did nothing on invoices, and what Send, Issue and Invoice are doing or waiting for on agreements. On Workers, an invoice send now waits for its email delivery. A delivery the host's operation policy refuses for 15 minutes ends as failed.
- Paste bank statement lines into the palette to record payments, and preview on Overblik what an open card would do.
- Rebuild Overblik's sections, lists, status badges, headings, error and 404 pages as plain sections between hairlines.
- Let people choose the interface language from the user menu and keep it in a cookie. Public document pages set `<html lang>` to the document's language.
- Sweep the forms: line VAT as a percent, typed dates in the locale's order, a customer summary page, CVR lookup on new customers where the runtime has one, spaced phone numbers, and clearer agreement lists and labels.
- Fix onboarding and Settings: a setup banner for unfinished hosted onboarding, required-field marks, the CVR on Firmaprofil, save results by their buttons, and stored payment terms.

See the [release notes](docs/releases/v0.15.0.md) for upgrade notes.

[Compare with v0.14.0](https://github.com/tielemans-dev/quits-oss/compare/v0.14.0...v0.15.0).

## [0.14.0](https://github.com/tielemans-dev/quits-oss/releases/tag/v0.14.0)

Changes since the published v0.13.0 tag, covering 36 merged PRs.

- **Breaking runtime contract:** billing providers must return the server-resolved `organizationAccess` decision and explicit `access` billing capabilities. Writes are refused when the decision is missing. The trial hook now runs on every successful onboarding with a `cvrVerified` flag.
- Return safe, localized client errors for expected managed sending-domain rejections. Export the typed rejection contract for runtime providers; unexpected failures remain server errors.
- Restyle the app shell, sidebar, top bar, Overblik and Settings, with Settings split into its own pages.
- Grow the command palette out of the Overblik field: complete half-typed requests, open request cards for what is typed, and optionally read whole sentences with a decision model when the operator configures one.
- Report whether email delivery is configured, refuse email jobs without delivery configuration, and run scheduler ticks during local development.
- Refresh document lists, details, Settings and financial panels after changes.
- Adopt the Vite+ toolchain and pin the Nitro build dependency.

See the [release notes](docs/releases/v0.14.0.md) for upgrade requirements.

[Compare with v0.13.0](https://github.com/tielemans-dev/quits-oss/compare/v0.13.0...v0.14.0).

## [0.13.0](https://github.com/tielemans-dev/quits-oss/releases/tag/v0.13.0)

Changes since the published v0.12.4 tag, covering 39 merged PRs.

- Add manual purchase VAT entries for reporting periods.
- Add e-conomic and Dinero payload mapping, accounting connection and mapping Settings, scheduled delivery through injectable transports, and delivery safeguards.
- Localize built-in fixed-price and milestone agreement templates in Danish and English.
- Add seller SE numbers and Danish VAT exemption and reverse-charge explanations to documents.
- Add an eight-second command-bar undo action and persist repeat-invoice send actions.
- Improve form validation, accessibility, mobile layouts, document colors and shared motion timings.
- Repair CI and test fixtures, and add nightly visual, accessibility and design reports.

See the [release notes](docs/releases/v0.13.0.md) for upgrade requirements and accounting integration limits.

[Compare with v0.12.4](https://github.com/tielemans-dev/quits-oss/compare/v0.12.4...v0.13.0).
