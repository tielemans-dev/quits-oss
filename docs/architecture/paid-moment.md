# Mark paid and undo

`invoices.markPaid` records the current remaining debt as one legacy `Payment`, with method
`manual` and the organization's current calendar date. It calls the existing `payment.record`
handler inside the command transaction. The organization and invoice locks serialize the balance
read with payments, receipt allocations and issued credits. No receipt is created.

`invoices.undoMarkPaid` calls the existing `payment.void` handler. That handler retains the original
row, sets `voidedAt` and `voidReason`, emits `payment.voided`, and recomputes settlement from all
active payments and issued credits. A paid invoice reopens as `sent`, or `overdue` if its due date
has passed. Other payments and receipt allocations remain active. The same settlement refresh
invalidates stale checkout sessions; reminder eligibility follows the restored status and balance.
No existing `payment.void` semantics changed. It still refuses receipt allocations with
`receipt_allocation_requires_reversal`.

## Contract for K6b

Schemas and types are exported from `@quits/contracts/invoices`:

```ts
// invoiceMarkPaidInputSchema / InvoiceMarkPaidInput
{ invoiceId: string, requestId: string }

// invoiceUndoMarkPaidInputSchema / InvoiceUndoMarkPaidInput
{ invoiceId: string, paymentId: string, requestId: string }

// invoicePaidMomentResultSchema / InvoicePaidMomentResult, for both mutations
{
  paymentId: string,
  invoiceStatus: "draft" | "sent" | "viewed" | "overdue" | "paid" | "credited",
  balance: { amount: string, currency: string },
  total: { amount: string, currency: string },
  paidFraction: string,
  undoUntil: string
}
```

Inputs are strict. IDs are trimmed and nonempty; `requestId` has a 100-character maximum. Money
amounts are exact major-unit decimal strings, currently returned with two places even for JPY,
e.g. `{ amount: "1000.00", currency: "JPY" }`. `total` is the original invoice gross total.
`paidFraction` is a decimal string in [0, 1], computed with decimal arithmetic as
`clamp((total - balance) / total, 0, 1)`, including credits. A zero total yields `"1"`.
Nonterminating fractions use the Decimal library's precision. Money is never rounded by this
convenience command. Unknown currencies, exponent-3 currencies, and balances with more decimal
places than their currency permits refuse with `currency_precision_unsupported`. The legacy
payment panel's existing fractional-balance exception is unchanged.

`undoUntil` is an ISO UTC timestamp exactly ten minutes after the mark command's server time.
The `invoice.marked_paid` version-1 event stores `{ paymentId, undoUntil }` as immutable provenance,
with the usual actor, command, organization, time and sequence envelope. Ordinary `manual`
payments do not have this event and cannot use undo. Undo records the reason `Fortrudt` and returns
the original deadline, without extending it. At the deadline and afterward it refuses with
`undo_expired`. An ordinary audited void remains available from the payments panel. The existing
`executeCommand` clock injection (`now`) supports boundary tests without sleeping.

`markPaid` requires `payment:create`; `undoMarkPaid` requires `payment:void`. Hide the undo action
when the user lacks that permission. These commands are user-only and absent from the agent
approval registry and MCP tools. Agents keep their existing payment approval flows.

## Retries and errors

The routers pass `invoice.mark_paid:<requestId>` and `invoice.undo_mark_paid:<requestId>` as
`clientRequestId` to `executeCommand`, whose receipts are also scoped by organization and actor.
Internal callers must use the same keys. Keep one request ID for each user intent, including a
retry after an uncertain response. Never reuse it for another invoice or payment. Both concurrent
and later retries return the first outcome, including its original deadline. Replaying a successful
mark after undo returns its original result without recording another payment. Replaying a
successful undo after expiry likewise returns its original result. Refetch the invoice for current
state after a retry; the receipt is a snapshot of the completed action. A fresh mark request on a
settled invoice refuses with `already_settled`.

Domain refusal codes reach tRPC clients as `error.data.reason`:

- `not_issued`: the invoice is a draft.
- `already_settled`: paid, credited or zero remaining balance.
- `invoice_not_payable`: voided, cancelled or another unsupported lifecycle state. The current
  normal lifecycle has no void/cancel states; imported values are rejected too.
- `currency_precision_unsupported`: the current balance cannot be recorded in a supported currency.
- `not_mark_paid_payment`: missing payment, wrong invoice or no mark-paid provenance.
- `receipt_allocation_requires_reversal`: a receipt allocation needs its reviewed reversal flow.
- `payment_already_voided`: a fresh undo request targets a payment already reversed.
- `undo_expired`: the server deadline has been reached.

Missing or foreign invoices use tRPC `NOT_FOUND`. Missing permissions use `FORBIDDEN`. Invalid
inputs use `BAD_REQUEST`. These transport errors have no feature-specific `data.reason`.

The previous `{ id }` mark-paid input and full-invoice response are replaced by the contract above.
The existing detail button sends the new input and still refetches the invoice. Payment history has a localized
`manual` method label, and the new audit event has Danish and English labels. Toast, undo button, animation
and query invalidation work belong to K6b.
