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
month as the due date. The detail page prints line prices with tax applied, so the scenarios assert line
quantities and the document totals but not per-line prices.

`scenarios.mjs` accepts the consumer's Playwright `test` and `expect`, avoiding a
second Playwright runtime. Consumers provide an `account` fixture with email and
password, and an `entryURL` fixture pointing to their application entry point.
The account must have a completed English-language organization with no invoices
and no contacts. Each test must start with that fresh state. Provisioning,
provider fakes, and database assertions belong to the consumer's fixtures.
Scenarios exercise the UI and must not import application or database internals.

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
