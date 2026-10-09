# Dashboard summary

`dashboard.summary()` is a read-only tRPC query requiring `invoice:read` and active organization
membership. It accepts no input. It retains `dashboard.stats` for existing clients. There is no UI
change. The public schema and types are exported from `@quits/contracts/dashboard` and the root
contracts entrypoint.

## Response

All fields are present except optional money `precisionSource` and bucket `oldestDaysOverdue`. Dates and times are strings. Money never passes through a JavaScript
number. The following TypeScript notation describes the exact JSON shape:

```ts
type Money = { currency: string; exponent: number; amount: string; precisionSource?: "storage" }
type Bucket = Money & { count: number; oldestDaysOverdue?: number }
type Total = { count: number; buckets: Bucket[]; unvalued: Bucket[] }
type Document = {
  documentId: string
  number: string | null
  customerName: string
  amount: Money
}
type Summary = {
  asOf: string // ISO timestamp
  timezone: string
  baseCurrency: string
  currencyMode: "per_currency"
  hasOtherCurrencies: boolean
  drafts: {
    count: number // nonnegative integer
    newestId: string | null
    newestKind: "invoice" | "quote" | null
  }
  outstanding: Total
  overdue: Total & { oldestDaysOverdue: number }
  paidThisMonth: Total // received cash, net of fees; legacy field name
  receivedByMonth: Array<Total & { month: string }> // YYYY-MM, exactly 12
  streak: number
  attention: Array<Document & {
    kind: "invoice" | "quote"
    dueDate: string | null // YYYY-MM-DD; invoices only, including drafts
    daysOverdue: number | null // nonnegative; issued invoices only
    isOverdue: boolean
    expiresOn: string | null // YYYY-MM-DD; quote_expiring only
    reason: "invoice_overdue" | "draft_older_than_7_days" | "quote_expiring"
      | "email_failed" | "email_unconfirmed"
    canRemind: boolean
  }> // at most 5
  incoming: Array<Document & {
    total: Money // original gross, before payments and credits
    isOverdue: boolean
    dueDate: string // stored YYYY-MM-DD calendar day, never shifted by timezone
    daysOverdue: number
    canRemind: boolean
  }> // at most 8
  activity: Array<{
    id: string
    sequence: number
    type: string
    aggregateType: string
    aggregateId: string
    occurredAt: string // ISO timestamp
    documentKind: "invoice" | "quote" | "credit_note" | "agreement" | null
    documentNumber: string | null
    customerName: string | null
  }> // at most 8
}
```

Buckets sort by currency code. For example, 100 DKK and 20 EUR are two buckets, never 120 of
anything. Amounts include exactly the currency's exponent, such as `"100.00"` DKK or `"100"` JPY.
No conversion uses a current exchange rate or an invoice's historical rate for cash received.

For supported currencies, `unvalued` is an informational subset of `buckets`. It contains invoices
without a known frozen valuation in the current base currency. Legacy payments and settlement
receipts have no stored base valuation, so their supported-currency totals appear in both arrays.

Unknown currencies and known exponent-3 currencies appear **only in `unvalued`**, even when an
invoice has a valuation. These legacy records cannot use the current settlement currency policy,
but must remain visible. Known exponents are retained, e.g. `"12.340"` KWD. Unknown currencies use
exponent 2 for the database's stored scale and carry `precisionSource: "storage"`; this is not a
claim about their ISO precision. The stored money columns are `Decimal(12,2)`, so exponent-3
amounts such as KWD and BHD have a padded trailing zero; no third decimal digit is recovered or
inferred. The contract is unchanged. Rows in attention/incoming retain the same exact representation.
Total `count` includes every record once, including these unsupported currencies.

K4b must display unvalued-only currencies as well as normal buckets. Match by currency to avoid
double-counting the overlapping supported buckets; never add the two arrays. Treat storage
precision as unknown currency precision and keep its original code instead of inventing an FX value.

Currency codes are trimmed and uppercased on read; received amounts with equivalent normalized
codes are grouped together. Codes still outside `[A-Z]{3}` are skipped in money totals, attention,
incoming and the streak, with a `dashboard.invalid_currency_skipped` log containing organization,
source and skipped row count. The raw malformed code is not logged and no fake currency combines
unrelated amounts. Draft inventory still counts editable drafts regardless of currency. An invalid
base-currency setting logs `dashboard.invalid_base_currency` and uses the existing USD fallback.

An empty total is `{ count: 0, buckets: [], unvalued: [] }`. An empty organization has twelve empty
monthly totals, zero streak and oldest days overdue, and empty attention, incoming and activity
arrays, and `drafts: { count: 0, newestId: null, newestKind: null }`. The UI can format zero using
`baseCurrency`; the API does not invent a currency-free zero amount. Missing settings use the existing USD/UTC defaults without creating settings.

## Definitions

- `drafts` counts all organization-scoped invoice and quote rows with `status = 'draft'`, except
  `lastEmailAttemptOutcome = 'sending'` (locked while the email is in flight). A refused send leaves
  an editable draft and is included. Each kind requires its own read permission; in particular,
  quote drafts require `quote:read`. This inventory has no age threshold or attention/activity cap.
  `newestId` and `newestKind` identify the most recently created eligible draft, ordered by creation
  timestamp descending, then id descending, then kind descending for ties. They are both null when
  count is zero. Exactly one draft can open directly; more than one can link to the draft list.

- Outstanding includes every non-draft invoice with positive `computeSettlement(invoice).balanceDue`.
  This is the exact helper used by the invoice list and payment status, including partial payments,
  credit notes, full credits, overpayments clamped to zero and voided-payment recomputation. Counts
  are invoices with positive balances, not all issued invoices.
- Overdue uses the same `dueDate < asOf` predicate as `markOrganizationInvoicesOverdue`, independent
  of the stored status badge. Both call `domain/documents/overdue.ts:isInvoicePastDue`, including
  the scheduler's organization scan and batch selection. Settlement-driven status changes also
  use this helper. Calendar days overdue are the nonnegative
  difference between the organization's local today and the stored UTC-midnight due calendar day.
  Due/expiry dates use `formatCalendarDate`, never an instant-to-local-time conversion. Just past the due timestamp on
  the same calendar date is overdue with zero days. Moving this to the end of the local due day
  remains a separate scheduler/status/dashboard change. Use `isOverdue`, not `daysOverdue > 0`, on
  attention and incoming. It is true only for an issued invoice with positive balance and
  `dueDate < asOf`. Drafts and quotes have `isOverdue: false`; draft invoices retain their due date
  but have `daysOverdue: null`. Quotes have null due date and days. Each overdue bucket also has
  `oldestDaysOverdue`, computed within that currency. The unvalued subset has its own maximum.
  Other totals omit the optional bucket field. The top-level maximum stays unchanged.
  The dashboard never updates lifecycle statuses.
  A list's stored badge can lag the scheduler; its balance and the underlying overdue predicate agree.
- Label `paidThisMonth` and the series as **received**, net of fees. The API field name stays for
  compatibility; this is neither invoice settlement nor revenue. Received money is non-voided legacy payments (`receiptId IS NULL`) plus active settlement
  receipts (`reversedAt IS NULL`), by `paidAt`, from the start of each local month through `asOf`.
  A receipt contributes its `netAmount` once, even if split across invoices or left unallocated.
  Its gross, processor fee and allocation rows are never added as more cash. Counts are legacy
  payment records plus receipt records, including fee-only receipts with zero net, not invoices
  or allocations. Future-dated records are excluded. The series starts eleven months before the
  current month and includes the partial current month. `paidThisMonth` uses the same aggregate
  as the last series entry. Receipt reversals and legacy payment voids remove the original record
  from its payment month; a corrected receipt contributes only its active replacement, on the
  replacement's payment date. This is a current-state projection, not historical reconstruction
  of what was known at a past `asOf`. Refunds are separate outflows and do not reduce this received
  money metric; reversing a refund likewise adds no receipt. Customer-credit classification,
  allocation reversals and credit notes do not create or remove cash receipts.
- The streak walks currently payment-settled, positive-value issued invoices, descending by their
  latest active payment's `paidAt`, then descending id. Payment includes receipt allocations in
  the invoice currency; their `paidAt` comes from the receipt, not the allocation date. Evidenced
  fees can make full debt settlement exceed net cash, without breaking an on-time streak. It stops
  at the first late or credit-assisted settlement. A qualifying invoice has payments covering its original gross and the last payment's
  local calendar date on or before its due date. Unsettled, zero-value and entirely credit-closed
  invoices are excluded. Voids and backdated payments can change this current-state streak. The
  full definition is also the `onTimeStreak` doc comment.
- Attention ranks overdue invoices by due timestamp, invoice/quote drafts older than seven elapsed days
  by creation time, excluding drafts whose latest email attempt is `sending`. Quote attention
  requires `quote:read`, including old drafts. Sent/viewed quotes expiring today through seven
  calendar days ahead follow, ordered by expiry day. The window uses UTC-midnight bounds for
  local today through today + 8 exclusive.
  Then come open invoices with a failed or uncertain latest email attempt by due timestamp.
  Id breaks ties. An overdue delivery failure appears once, in the higher-priority overdue group.
  There is no persisted bounce state. `email_unconfirmed` means uncertain, not proven undelivered.
- `canRemind` checks send permission, open settlement, a valid recipient, provider availability and
  the manual reminder's current offset slot. Pausing automatic reminders does not disable manual
  reminders. The command checks again under lock before sending. Nothing in this query sends email.
- `hasOtherCurrencies` is true if any bucket in outstanding, overdue, received this month or any of the
  twelve monthly totals differs from `baseCurrency`. Unvalued subsets are checked too. Draft-only
  foreign currencies and receipts outside the window do not set the flag.
- Incoming contains the earliest due outstanding invoices, with the balance still owed in `amount`
  and the original invoice gross in `total`. Both use the same native currency. The UI can calculate
  `1 - amount / total` with decimal arithmetic; credits count as settled, like payments. Incoming
  rows always have positive balance and positive total, so this denominator is nonzero. Drafts
  appear in the draft inventory and, when old enough and editable, attention. Activity projects the latest
  document/payment events by organization sequence, using the existing `DomainEvent` source. Organization settings, agent events, audit
  payloads, actor details and command results are not exposed through invoice-read permission.
  Display fields come from current document/contact rows in the same organization and snapshot,
  not event payloads. Numbers are null for current drafts, including legacy numbered drafts.
  Missing/deleted or foreign document references resolve all display fields to null. A foreign
  contact reference resolves the customer name to null. Payment aggregates resolve through their
  scoped payment's invoice; current payment events already aggregate on the invoice.
- Attention carries its own dates, independent of the eight incoming rows. `expiresOn` is the
  stored quote expiry calendar day only for `quote_expiring`, and null for other reasons.

## Activity allowlist and reminder refusals

`DASHBOARD_ACTIVITY_EVENT_TYPES` is the single exported allowlist in `@quits/contracts/dashboard`.
`DashboardActivityEventType` is its string-literal union for UI label mappings. The server applies
it before the cap of eight and orders by descending organization sequence. It also filters both
event type and aggregate kind by `DOCUMENT_READ_PERMISSION`, shared with `activity.forDocument`:
`quote:read`, `creditNote:read`, `agreement:read`, and `invoice:read` for invoices/payments. An
unreadable event cannot consume a slot or expose its ID or display fields. The event `type` field
keeps its existing string schema for additive compatibility.

The UI's named types all exist in the real `eventRegistry`. Its `*.email_failed` and
`*.email_unconfirmed` wildcards expand to invoice, quote, credit_note and agreement, yielding
28 explicit entries. No named type needed renaming. Other real types such as `quote.email_resent`,
`agreement.email_resent`, `credit_note.sent`, `payment.failed`, `agreement.declined` and artifact,
valuation or draft-update events are intentionally excluded from this requested set. New types
need a deliberate addition to the shared constant and a UI label.

`reminders.sendNow` already carries `InvalidState` refusal codes through `DomainRefusal` in the
tRPC error cause and `error.data.reason` in the HTTP response.
The integration test exercises the real fetch adapter and command for all four domain reasons:
`not_remindable`, `missing_recipient`, `email_unavailable`, `already_reminded`. The tRPC code is
`BAD_REQUEST`. Missing records or permission/authentication failures use the ordinary tRPC
`NOT_FOUND`, `FORBIDDEN` or `UNAUTHORIZED` codes; their `data.reason` may be null.

Definite provider failures after queuing throw `PRECONDITION_FAILED` (HTTP 412), with an
`ExternalFailure` domain cause and one of these stable `data.reason` values:

- `email_provider_refused`: the provider rejected the request, including authentication or
  validation errors. Legacy rejected delivery results without a classification also use this code.
- `email_provider_unreachable`: SMTP positively identified a connection failure before message
  submission (`smtp_unavailable`). This does not claim that an ambiguous timeout delivered nothing.

Provider messages and arbitrary provider codes are never used as client error text. Both paths use
fixed configuration guidance. Rejected delivery decisions and results store the safe classification
and message, so retrying settlement preserves the reason and reminder/document history stays safe.
The shared email-result adapter applies the same codes to other document email refusals. Legacy
rejected results, failed reminder history and document `lastEmailAttemptMessage` fields are also
sanitized when read, including lists, details, recurring invoice rows and agent invoice reads.
Sanitizing inside `settle()` covers abandoned deliveries with legacy pinned provider decisions;
the pinned `job.payload.decision`, job result, completion callback and newly emitted events all
receive the safe message. Exact app-authored withdrawal messages remain unchanged on document
reads. Automatic-send messages preserve the prefix and known app-authored details, while unknown
suffixes are replaced with safe provider guidance. No database migration
is required for the optional code in the outbox's JSON records.

Uncertain delivery remains `pending` or `unconfirmed` in the successful response's `delivery`
field. A lost response or an error after an earlier uncertain attempt is never relabeled as a
proven refusal. The outbox retains its existing retry/idempotency behavior.

Reminder timing is unchanged in `domain/commands/reminders.ts`: `planDueReminders` and
`nextPolicyReminder` add `offsetDays * 86_400_000` to the stored due timestamp; manual sends use
`floor((now - dueDate) / 86_400_000)` as their offset slot. `reminderStage` switches to overdue
at `dueDate + 86_400_000`. Scheduled reminder SQL uses those same timestamp-offset windows.
The dashboard's reminder-slot join uses that same elapsed-day offset. These are separate from
calendar `daysOverdue` and need review in the later end-of-due-day policy change.

## Queries and indexes

The helper executes at most six SELECTs in a repeatable-read transaction with an explicit 30-second
timeout: settings, narrow invoice rows
with contacts and the current reminder slot, SQL legacy-payment/receipt sums grouped by currency and local month,
old draft/expiring quotes, one complete draft count/newest aggregate, and eight allowed events joined
to scoped document/contact display fields. Without quote read permission the attention quote query
is skipped. tRPC membership resolution adds its existing query.
Transaction control statements are separate. There are no per-invoice round trips, line-item loads
or document snapshot loads. The invoice pass remains O(number of organization invoices) to reuse
settlement arithmetic and derive the streak; it is not a constant-memory aggregate of all history.

The existing indexes were checked against PostgreSQL on port 55473:

- `invoice(organizationId, status)` bounds the organization's invoice scan.
- `contact` primary key serves the contact joins; the organization id is checked on both sides.
- `invoice_reminder(invoiceId, offsetDays)` is unique and serves the current reminder slot join.
- `payment(organizationId, paidAt)` bounds the twelve-month legacy payment aggregation.
- `settlement_receipt(organizationId, paidAt)` is added by `20261014020000_dashboard_receipt_months`
  to bound the receipt side of that same SQL aggregate. Both branches filter dates before summing.
- `quote(organizationId, status)` bounds eligible quotes; expiry sorting is local to that result.
- `domain_event(organizationId, sequence)` is unique and supports newest-first activity.
  `domain_event(organizationId, type)` also supports the event-type allowlist filter. The activity
  joins resolve at most eight events through primary keys, with organization checks on every join.

The database integration test asserts exactly six SELECTs with one invoice and with 501 invoices
plus 500 receipts, seeds allocations and credit rows, reconciles with `invoices.list`, and uses a
non-UTC PostgreSQL session to check timestamp handling. Command-driven fixtures also compare
outstanding, overdue and incoming against `invoices.get` and `payments.list`, across legacy
payments, full and split/cross-currency allocations, corrections, reversals, refunds, customer-credit
classification, partial payments and credit notes. Calendar-date tests cover Copenhagen, New York,
Pago Pago and Tokyo, including on-due-day settlement and the quote expiry window.

## Settlement and activity adapters

### Receipt allocations, PR #72 (integrated)

`moneyReceived` follows the [receipt model](settlement-receipts.md) with one SQL `UNION ALL` of
active legacy payments and active receipt net amounts, grouped once by native currency/month.
The compatibility `dashboard.stats` endpoint uses this same helper without a lower date bound,
adding its monthly subtotals for all-time received cash. Its legacy `totalRevenue` field name is
retained but must not be used as the display label. Its response shape remains unchanged.
`receiptBalanceFromTotals` measures available gross
funding after allocations and refunds, so it is not the source of a cash-received figure.

`amountStillOwed` and the streak reuse `computeSettlement` and the invoice totals maintained by
`refreshInvoiceSettlement`. Legacy payments and active allocation `Payment.amount` discharge
invoice debt; allocation `receiptAmount` consumes funding in its own currency. A DKK 100 invoice
paid through a DKK 95 net receipt with an evidenced DKK 5 fee is fully settled and can extend the
streak, while cash received is DKK 95. Reversing an allocation recomputes debt and removes a
reopened invoice from the streak; it does not reverse the receipt's cash. No exchange rate or
alternative settlement arithmetic is introduced here.

The activity contract/allowlist is unchanged. Receipt events require an explicit future addition
and corresponding UI labels if they are wanted on the dashboard.

### Operation journal, PR #74

No mandatory change to `recentActivity`: the journal retains `DomainEvent`. Its new delivery
events are not in the dashboard allowlist; adding them requires both an allowlist entry and UI
labels. If product scope expands to failed commands, approval waits and queued jobs,
replace only `recentActivity` with a bounded organization-wide journal projection and extend the
activity contract explicitly. Do not call `documentJournal` once per invoice. Its document-level
query and recovery permissions are not a dashboard aggregation API. Never expose email bodies,
raw command results or label provider acceptance as inbox delivery.
