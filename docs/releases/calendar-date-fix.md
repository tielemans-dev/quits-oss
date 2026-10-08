# Calendar dates west of UTC

**Calendar dates shown one day early west of UTC (fixed).** In a timezone west of UTC, such as the Americas, due dates and quote expiry dates were one day early in several places. Organisations at or east of UTC, including every Danish one, were not affected. Reminder emails were always correct. The affected places and the release each started in:
- the invoice PDF, invoice and quote emails and the invoice detail page, since v0.1.0;
- the accounting CSV and the legacy export mapper (v0.2.0);
- the record frozen at issuance and the snapshot-based UBL (v0.3.0) built from it;
- the public pay and quote pages, for customers viewing from a western timezone.

After upgrading, everything rendered live shows the correct date, for older invoices too: the detail page, the public pages, new emails and CSV exports. Invoice due dates and quote expiry dates stored with a time of day, including due dates on invoices created from deliverables, are normalised to their calendar day in each document's stored timezone.

The invoice's `dueDate` is the authoritative due date. Records frozen at issuance are evidence and are not rewritten. So for invoices issued before the upgrade, these keep the earlier date:
- the stored PDF and UBL;
- `issuanceSnapshot.dueDate`, which agents also see;
- the `invoice.issued` event.

Issued PDFs are never regenerated. If a customer needs a corrected document, issue a credit note and a new invoice.

## Sweep

The schema uses `DateTime` for most document dates. Classification below also
checks the command writers. All paths are relative to `apps/oss/src`.

| Field | Place | Verdict |
| --- | --- | --- |
| Invoice `dueDate` | Invoice commands, quote conversion, recurring generation, deliverable invoice writer | Calendar date. All datetime inputs now retain their written day and become UTC midnight. The deliverable default now adds calendar days to the agreement's local issue day, stored at UTC midnight. |
| Invoice `dueDate` | `domain/documents/money-snapshot.ts` | Fixed: freeze `toISOString().slice(0, 10)`, like supply date. |
| Invoice `dueDate` | `domain/documents/render-input.ts`, `einvoice-input.ts` | PDF input preserves the stored ISO date; UBL input takes the corrected money snapshot. No second timezone conversion. |
| Invoice `dueDate` | `lib/invoice-pdf.tsx`, invoice detail route | Fixed: display in UTC. Issue timestamp still uses the organisation timezone. |
| Invoice `dueDate` | `lib/email.ts` send/resend subject and body | Fixed: display in UTC. |
| Quote `expiryDate` | Quote commands, `lib/email.ts`, public quote page | Calendar date written from date-only input. Approval context already slices ISO. Fixed email subject/body and public display to UTC. |
| Invoice `dueDate` | Public pay page and `use-document-format.ts` | Fixed: separate calendar-date formatting from timestamp formatting. |
| Invoice `dueDate` | `lib/exports/accounting-csv.ts` | Fixed: serialize its UTC day. Issue dates and payment instants still use the export timezone. |
| Invoice `dueDate`, `supplyDate` | `lib/exports/einvoice.ts` legacy mapper | Fixed: serialize UTC days for both fields. Stored UBL artifacts are not regenerated. |
| Invoice/quote `supplyDate` | Invoice writer, money snapshot, PDF input/display, invoice detail, UBL | Invoice defaults derive a calendar date from the issue instant; explicit dates remain UTC dates. Snapshot slices ISO; display already uses UTC. Quote supply date has no active writer/display. |
| Invoice `dueDate`, quote `expiryDate` | Invoice/quote lists, quote detail, dashboard recent invoices on this main baseline | Already safe: shared formatter defaults to UTC, including when a browser timezone is west of UTC. Dashboard serializes ISO dates. |
| Due/supply/expiry dates | Agent/MCP document presenters, approval contexts, event payloads | Already safe: Date/ISO serialization or ISO slicing, with no organisation/browser timezone conversion. The corrected issuance snapshot is also exposed. |
| Recurring `startDate`, `nextRunAt`, `endsAt`, invoice `recurringRunDate` | Recurring date helpers, commands/scheduler, recurring UI | UTC calendar dates. Arithmetic uses UTC fields; comparisons use UTC dates/instants; display explicitly uses UTC. |
| Reminder `scheduledFor`, invoice `dueDate` | Reminder commands, scheduler, reminder email and panel | UTC scheduling arithmetic and comparisons; due/scheduled date display already uses UTC. `sentAt` is an instant. |
| Invoice `dueDate` | Settlement and overdue scheduler | Direct UTC date/instant comparisons, no timezone reformatting. Existing overdue boundary policy is unchanged. |
| Agreement `validUntil`, deliverable `agreedDate`, `expectedDate` | Prisma `@db.Date`, agreement writers/snapshots, agreement/deliverable UI and PDF | UTC calendar dates. Snapshots preserve ISO; displays use UTC or ISO slicing. |
| Agreement `expiresAt` | `domain/agreements/expiry.ts` and expiry scheduler | Intentional instant at the end of `validUntil` in the frozen organisation timezone. The calendar date itself is read with ISO slicing before finding that instant. |
| Invoice/quote/credit-note `issueDate`, event `issuedAt`/`createdAt`, decision/delivery timestamps | Issuance writers, snapshots, PDF, email, public pages, exports | Instants, including credit-note dates. Timezone-aware formatting is correct and retained. |
| Payment `paidAt`, invoice `paidAt` | Payment command, panel, CSV, approval context | Instants. Date-only payment input is explicitly converted to the start of that day in the organisation timezone, not UTC midnight. Keep timezone-aware formatting. |
| Valuation `rateDate`, posting/tax-point dates | Contracts, frozen money and accounting events | Date strings, passed through without timezone conversion. Issue-derived dates intentionally use the issue instant's organisation day. |
| Service period | Prisma schema and contracts | No dedicated service-period calendar columns in this baseline. Delivery dates are covered above. |
| Auth/key/link/approval expiry | Prisma schema and corresponding writers | Timestamp expiry, not a document calendar date. Unchanged. |

## Regression coverage

The real tRPC `createV2` → `send` → `get` flow covers New York, Pago Pago and
Copenhagen for 2026-11-07, 2028-02-29, 2027-03-14 and 2026-11-01. It checks
stored columns, the frozen money snapshot, issued API view, PDF render input,
UBL render input and the legacy export mapper. Before the fix, all eight western
cases failed with a one-day-early frozen due date; all four Copenhagen cases passed.

Additional tests exercise PDF text, send-email subjects and bodies, public pay
and quote rendering, and accounting CSV. They also verify that issue instants
still use the organisation timezone.

## Writer and migration follow-up

`20261014000000_normalize_calendar_dates` changes only non-midnight live
`invoice.dueDate` and `quote.expiryDate` values. Each row's own `timezone` column
is matched case-insensitively against PostgreSQL's `pg_timezone_names`, with
surrounding whitespace trimmed; current organisation settings
are not used. Blank or unrecognised timezone values are left unchanged, as are
all values already at UTC midnight. The conversion explicitly interprets the old
stored timestamp as UTC before finding the document's local day, regardless of
the database session timezone. No snapshot, event, artifact reference, hash or
`updatedAt` is rewritten.

The migration fixture has 16 live rows. It changes 10 rows, five invoices and five
quotes. Two UTC-midnight rows and four rows with blank/unknown timezones remain
unchanged. Running it again changes zero rows. The test compares every column and
the issuance event before and after, with organisation and database timezones that
differ from the documents.

The writer sweep covered invoice create/update, linked-invoice updates, issuance
supply-date overrides, quote create/update/conversion, recurring generation and
invoices created from deliverables. Only the deliverable due-date default used
instant arithmetic. Invoice due-date and quote expiry inputs also allowed stored
instants. Supply dates already had date-only schemas and writers; recurring dates
use UTC calendar helpers and agreement/deliverable dates use `@db.Date`, so none
need a data migration. All calendar inputs now share datetime normalization,
including supply, rate, recurring and agreement dates. Explicit invoice issue dates
and payment timestamps remain instants.

Writer tests cover Copenhagen just after midnight, New York in the evening and
New York across spring DST. API tests verify datetime inputs through create,
update and send. Independent soft assertions let the original issuance matrix
report snapshot, legacy mapper, PDF input and UBL input failures together.
