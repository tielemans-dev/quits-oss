# Dashboard summary

`dashboard.summary()` is a read-only tRPC query requiring `invoice:read` and active organization
membership. It accepts no input. It retains `dashboard.stats` for existing clients. There is no UI
change. The public schema and types are exported from `@quits/contracts/dashboard` and the root
contracts entrypoint.

## Response

All fields are present. Dates and times are strings. Money never passes through a JavaScript
number. The following TypeScript notation describes the exact JSON shape:

```ts
type Money = { currency: string; exponent: number; amount: string }
type Bucket = Money & { count: number }
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
  outstanding: Total
  overdue: Total & { oldestDaysOverdue: number }
  paidThisMonth: Total
  receivedByMonth: Array<Total & { month: string }> // YYYY-MM, exactly 12
  streak: number
  attention: Array<Document & {
    kind: "invoice" | "quote"
    reason: "invoice_overdue" | "draft_older_than_7_days" | "quote_expiring"
      | "email_failed" | "email_unconfirmed"
    canRemind: boolean
  }> // at most 5
  incoming: Array<Document & {
    dueDate: string // YYYY-MM-DD in the organization's timezone
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
  }> // at most 8
}
```

Buckets sort by currency code. For example, 100 DKK and 20 EUR are two buckets, never 120 of
anything. Amounts include exactly the currency's exponent, such as `"100.00"` DKK or `"100"` JPY.
No conversion uses a current exchange rate or an invoice's historical rate for cash received.

`unvalued` is an informational subset of `buckets`, not an additional total. For invoices it
contains balances whose invoice has no frozen base valuation, an unknown valuation, a null base
amount, or a valuation in a different base currency than the current organization setting.
Payments have no stored base valuation on this baseline, so all received-money buckets also
appear in `unvalued`. Every amount remains included in the primary native-currency buckets.

An empty total is `{ count: 0, buckets: [], unvalued: [] }`. An empty organization has twelve empty
monthly totals, zero streak and oldest days overdue, and empty attention, incoming and activity
arrays. The UI can format zero using `baseCurrency`; the API does not invent a currency-free zero
amount. Missing settings use the existing USD/UTC defaults without creating settings.

## Definitions

- Outstanding includes every non-draft invoice with positive `computeSettlement(invoice).balanceDue`.
  This is the exact helper used by the invoice list and payment status, including partial payments,
  credit notes, full credits, overpayments clamped to zero and voided-payment recomputation. Counts
  are invoices with positive balances, not all issued invoices.
- Overdue uses the same `dueDate < asOf` predicate as `markOrganizationInvoicesOverdue`, independent
  of the stored status badge. Calendar days overdue are the difference between the current and due
  dates in the organization's timezone, not elapsed 24-hour periods. Just past the due timestamp on
  the same calendar date is overdue with zero days. The dashboard never updates lifecycle statuses.
  A list's stored badge can lag the scheduler; its balance and the underlying overdue predicate agree.
- Received money is non-voided payments by `paidAt`, from the start of each local month through
  `asOf`. Future-dated payments are excluded. The series starts eleven months before the current
  month and includes the partial current month. Counts are payment records, not invoices or
  customers. `paidThisMonth` uses the same aggregate as the last series entry. Credit notes reduce
  debt, never cash received.
- The streak walks currently payment-settled, positive-value issued invoices, descending by their
  latest active payment's `paidAt`, then descending id. It stops at the first late or credit-assisted
  settlement. A qualifying invoice has payments covering its original gross and the last payment's
  local calendar date on or before its due date. Unsettled, zero-value and entirely credit-closed
  invoices are excluded. Voids and backdated payments can change this current-state streak. The
  full definition is also the `onTimeStreak` doc comment.
- Attention ranks overdue invoices by due timestamp, invoice/quote drafts older than seven elapsed days
  by creation time, sent/viewed quotes expiring today through seven local calendar days ahead by
  expiry time, then open invoices with a failed or uncertain latest email attempt by due timestamp.
  Id breaks ties. An overdue delivery failure appears once, in the higher-priority overdue group.
  There is no persisted bounce state. `email_unconfirmed` means uncertain, not proven undelivered.
- `canRemind` checks send permission, open settlement, a valid recipient, provider availability and
  the manual reminder's current offset slot. Pausing automatic reminders does not disable manual
  reminders. The command checks again under lock before sending. Nothing in this query sends email.
- Incoming contains the earliest due outstanding invoices, with the balance still owed. Drafts
  appear only in attention. Activity projects the latest document/payment events by organization
  sequence, using the existing `DomainEvent` source. Organization settings, agent events, audit
  payloads, actor details and command results are not exposed through invoice-read permission.

## Queries and indexes

The helper executes five SELECTs in a repeatable-read transaction: settings, narrow invoice rows
with contacts and the current reminder slot, SQL payment sums grouped by currency and local month,
old draft/expiring quotes, and eight event projections. tRPC membership resolution adds its existing query.
Transaction control statements are separate. There are no per-invoice round trips, line-item loads
or document snapshot loads. The invoice pass remains O(number of organization invoices) to reuse
settlement arithmetic and derive the streak; it is not a constant-memory aggregate of all history.

The existing indexes were checked against PostgreSQL on port 55473:

- `invoice(organizationId, status)` bounds the organization's invoice scan.
- `contact` primary key serves the contact joins; the organization id is checked on both sides.
- `invoice_reminder(invoiceId, offsetDays)` is unique and serves the current reminder slot join.
- `payment(organizationId, paidAt)` bounds the twelve-month receipt aggregation.
- `quote(organizationId, status)` bounds eligible quotes; expiry sorting is local to that result.
- `domain_event(organizationId, sequence)` is unique and supports newest-first activity.

No new index or migration is needed for these access paths. The database integration test asserts
exactly five SELECTs with one invoice and 501 invoices, seeds payment and credit rows, reconciles
with `invoices.list`, and uses a non-UTC PostgreSQL session to check timestamp handling.

## Adapting after the research PRs merge

### Receipt allocations, PR #72

Change `moneyReceived` only for money semantics. Union active legacy payments (`receiptId IS NULL`,
`voidedAt IS NULL`) with active `SettlementReceipt` rows (`reversedAt IS NULL`). Sum `netAmount` once
per receipt, in its own currency, by `paidAt`; count each receipt once, including unallocated funds.
Do not add allocation `Payment.amount` or `receiptAmount` as receipts, and do not use `grossAmount`
for the bank-money figure. Fees explain the difference between debt settled and cash received.
Refunds are outflows, so this received-money metric does not subtract them. Receipt reversals remove
erroneous receipts just as voids remove legacy payments. Add split-allocation, cross-currency,
fee, unallocated-fund and reversal fixtures. Check/add `(organizationId, paidAt)` on
`settlement_receipt`; the reviewed diff only has organization/contact and organization/reference
indexes. Extend `recentActivity`'s allowed aggregate types with `settlement_receipt` if receipt
activity is wanted on the dashboard.

`amountStillOwed` and the streak retain `computeSettlement` and the refreshed invoice totals.
PR #72 deliberately keeps payment allocations as the debt-discharge records and refreshes those
same columns. Keep tests for reversed allocations reopening debt.

### Operation journal, PR #74

No mandatory change to `recentActivity`: the journal retains `DomainEvent`, and its new delivery
events use document aggregate types already included here. The current contract will show them
as event metadata. If product scope expands to failed commands, approval waits and queued jobs,
replace only `recentActivity` with a bounded organization-wide journal projection and extend the
activity contract explicitly. Do not call `documentJournal` once per invoice. Its document-level
query and recovery permissions are not a dashboard aggregation API. Never expose email bodies,
raw command results or label provider acceptance as inbox delivery.
