# Shared browser scenarios

`bun run test:e2e:shared` from the repository root builds the app and runs Chromium
against a disposable PostgreSQL 16 container. Install dependencies and Chromium first:

```sh
bun install --frozen-lockfile
(cd apps/oss && bunx playwright install --with-deps chromium)
bun run test:e2e:shared
```

Requires Docker, Node 22+, Bun, free port 4310, and a checkout without active
`.env` or `.dev.vars` files. The runner rejects such files before building. No database URL or provider
credentials are needed. The runner ignores caller database/provider settings and
cleans up its container and child processes after success, failure, or interruption.
Logs remain in `apps/oss/test-results/shared-logs`, with the HTML report in
`apps/oss/playwright-report/shared`. Do not run simultaneous builds in this checkout.

The scenarios cover login, session persistence, contact creation with readback after
a reload, and a draft invoice journey: create an invoice for a new customer with two
line items and a tax rate, check the live summary, save, and verify the stored totals
after a reload and in the invoice list; edit the draft and verify the recalculated
total; and download the draft's PDF and check its filename (`draft.pdf`), PDF signature, end marker,
and minimum size. A draft has no number until it is sent, so the scenarios find it by its
customer and the "Draft invoice" heading. They do not yet cover sending an invoice, payments, or stored PDF
artifacts of issued documents, which need provider fakes the consumer must supply.
Add those as browser journeys using the same fixture contract.

The scenarios assume an English-language organization that invoices in US dollars, and
require the browser context's `timezoneId` to be `UTC`, and select the 15th of next
month as the due date. The organization's prices exclude tax. The detail page therefore prints
each line's net unit price and net amount under "excl. tax" headers, the lines add up to the
subtotal, and the scenarios assert the per-line prices, the line amounts, the subtotal, the tax row
for the rate and the total.

`scenarios.mjs` accepts the consumer's Playwright `test` and `expect`, avoiding a
second Playwright runtime. Consumers provide an `account` fixture with email and
password, and an `entryURL` fixture pointing to their application entry point.
The account must have a completed English-language organization with no invoices
and no contacts. Each test must start with that fresh state. Provisioning,
provider fakes, and database assertions belong to the consumer's fixtures.
Scenarios exercise the UI and must not import application or database internals.

The optional third argument to `registerProductScenarios` configures invoice tax.
Omitting it preserves the editable 10% rate used by self-hosted scenarios. A consumer
with a fixed 25% rate registers the same journeys as follows:

```ts
registerProductScenarios(test, expect, {
  invoiceTax: { ratePercent: 25, editable: false },
})
```

`invoiceTax` requires both a percentage in `ratePercent` and an `editable` boolean.
The consumer's fixtures must provision the matching tax policy; this option does
not change organization settings. Editable scenarios fill the summary tax input and
check its value. Fixed-rate scenarios assert that input is absent on both create
and edit. All three invoice journeys use the chosen rate for live totals; the create
and edit journeys also verify the stored tax label and totals after reload. The
English-language, US-dollar and tax-exclusive price assumptions still apply.

The app tarball includes `e2e/`, so scenarios are versioned with the application.
`@quits/oss/e2e` exports the scenario registration function. It has no runtime
Playwright import; consumers install Playwright themselves. The packed-artifact
check verifies that scenarios, declarations, and runner helpers are present.

To inspect a local artifact before publishing:

```sh
(cd apps/oss && bun pm pack --destination /tmp)
```

An integrating application can explicitly consume that tarball locally. Its CI
should use the scenarios from its installed, published application version.

## Historical payment captures

The opt-in QUI-52 workflows use `qui52-capture.mjs` for the pinned baseline and
`qui52-current-capture.mjs` for the current head. Both delegate setup, build,
serve, capture and cleanup to `qui52-runner.mjs`. They use synthetic data,
disposable PostgreSQL and a local Mailpit email sink.

The baseline produces eight dark invoice/email images. The current-head fixture
issues invoices, changes live seller/payment settings, and captures the issued
invoice and delivered payment emails in Danish and English, at desktop and
mobile sizes, in light and dark themes. Its workflow requires 16 images and
records their hashes in `current-manifest.json`; it does not use draft-only mode.
