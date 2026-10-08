# Calendar dates west of UTC

Self-hosted organisations west of UTC that issued invoices on v0.6.0 or v0.7.0
are affected by an issuance bug: the frozen due date and the UBL due date are
one day earlier than the date entered. This release preserves the calendar date
for newly issued invoices and fixes related date displays and exports.
Already-issued snapshots and stored PDF/UBL artifacts are immutable evidence
and are not rewritten or backfilled by this fix.

## Sweep

The schema uses `DateTime` for most document dates. Classification below also
checks the command writers. All paths are relative to `apps/oss/src`.

| Field | Place | Verdict |
| --- | --- | --- |
| Invoice `dueDate` | Invoice commands, quote conversion, recurring generation, deliverable invoice writer | Calendar date. Date-only input becomes UTC midnight. The deliverable writer's default can retain a time component; this patch preserves its UTC calendar day. |
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
