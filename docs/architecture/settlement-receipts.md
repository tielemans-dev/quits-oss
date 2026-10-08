# Receipt allocation and corrections

A receipt records customer funds separately from invoice debt. A 985 DKK receipt allocated to a
1000 DKK invoice leaves 15 DKK due. Entering an evidenced 15 DKK processor fee records a gross
settlement of 1000 DKK, a fee of 15 DKK and a net receipt of 985 DKK. Allocating that gross amount
closes the invoice. Quits never derives a fee or a writeoff from the difference.

## Stored quantities and commands

`SettlementReceipt.id` identifies funding owned by one organization and one customer. Its
currency, gross, net, fee, payment date and original evidence do not change. The bank/provider
transaction reference is unique within the organization. A corrected receipt is reversed and a
new receipt is recorded with a new reference. Existing references cannot be silently reused.

A `Payment` with `receiptId` is an allocation. `Payment.amount` discharges debt in the invoice
currency; `receiptAmount` consumes funds in the receipt currency. Existing invoice settlement,
checkout invalidation, reminder and paid-status rules continue to use these payment rows.
Legacy payments retain null receipt fields. There is no guessed backfill or automatic adoption of
provider payments. Do not record an existing payment again as a new receipt.

For each active receipt:

```
gross = net + processor fee
available = gross - active allocations in receipt currency - active refunds
available >= 0
```

Allocation is limited to the remaining invoice debt and the receipt's available amount. Multiple
invoices may share one receipt if they belong to the same customer. A batch either commits all
its allocations or commits none. Unallocated funds remain visible without an inferred treatment.
The explicit `customer_credit` action records the operator's reason and evidence for keeping the
residual for that customer. It changes classification only and creates no additional funds.
Reversals clear that current classification because restored funds need a fresh explanation;
the original classification remains in the immutable event history.

Refunds consume available funds. To refund already allocated money, first reverse its allocation,
then issue a credit note if the supply was cancelled, then record the refund. The refund command
records an external bank/processor refund; it does not send money. A credit note that would credit
receipt-funded paid amounts refuses with `receipt_allocations_pending` until those allocations are
released. Legacy payment/credit behavior is unchanged.

An allocation reversal restores both frozen currency quantities and recomputes invoice debt.
A refund reversal restores the original receipt quantity. A receipt can be reversed only after
all active allocations and refunds have been reversed. Original rows and events remain retained.
The ordinary `payment.void` command refuses receipt allocations so it cannot bypass this audit.

All new amounts are decimal strings with at most ten integer digits and two decimal places,
matching `Decimal(12,2)`. Currency precision follows the shared currency catalogue. Exponent-0
currencies refuse fractions. Unknown and exponent-3 currencies are refused. Decimal arithmetic
never rounds a submitted receipt or allocation. For cross-currency allocations the operator
supplies both exact quantities and evidence for their conversion. Any rounding residual stays on
its original side. Reversal uses the original quantities and does not recompute an exchange rate.

The API exposes `payments.recordReceipt`, `payments.receipts`, `payments.previewAllocation`,
`payments.allocateReceipt`, `payments.previewReceiptChange` and `payments.changeReceipt`.
Creating and allocating require `payment:create`; refunds and reversals require `payment:void`.
Classification currently requires a user actor. Agent automation is not enabled.

Mutation inputs include `requestId`. The routers pass it to `executeCommand` as a scoped
idempotency key. Internal callers must also pass the same `clientRequestId` on retries. The
existing command transaction takes the organization row lock; receipt operations also take the
receipt row lock. This serializes allocation, legacy payments and credits in the organization.
Allocation and correction commits require the server preview's fingerprint. A changed balance or
classification refuses the old preview. Both allocation and correction previews bind the current
customer-credit reason and evidence, even when funds and invoice balances have not changed.
Correction previews show the classification before and after the change, including any
classification being replaced or cleared. The UI retains a request ID when retrying an uncertain
response and creates another when the operator changes the proposed action.

Reasons and HTTP(S) evidence links are mandatory. Fee and currency-conversion evidence are
separate from the allocation evidence. Links are references supplied by the operator; Quits does
not fetch or independently verify their contents. Domain-event envelopes record actor kind, actor
ID, command ID, occurrence time, sequence and schema version.

## Accounting export contract

The `settlements` CSV exports immutable events in organization sequence order, selected by event
occurrence time in the organization's time zone. It carries event ID, schema version, occurrence
time, type, actor kind/ID, command ID and the exact JSON payload. The receipt's payment date stays
inside its original event. Consumers deduplicate by event ID, retain consumed versions, and follow
the existing event-consumer acknowledgement protocol for incremental delivery.

| Event, version 1 | Meaning |
| --- | --- |
| `settlement.receipt_recorded` | Gross customer funding, net receipt and processor fee, each separately named in receipt currency. Includes customer, payment date, reference and fee evidence. |
| `settlement.allocated` | Apply receipt funding to invoice debt. Includes receipt ID, payment ID, both currency quantities, remaining debt and conversion evidence. No cash receipt or invoice revenue is created again. |
| `settlement.changed`, `refund` | Return the stated receipt-currency amount. `targetId` identifies the refund. |
| `settlement.changed`, `reverse_allocation` | Reverse the allocation identified by `targetId` and its frozen receipt/invoice quantities. |
| `settlement.changed`, `reverse_refund` | Reverse the original refund identified by `targetId`. |
| `settlement.changed`, `reverse_receipt` | Reverse the original receipt identified by `targetId`, including its original net and fee components. Look up the original receipt event; do not infer its components from gross alone. |
| `settlement.changed`, `customer_credit` | Classification evidence for the current residual. This is metadata, not a second liability or receipt. |

Settlement commands emit no `payment.recorded` event. Payment CSV columns retain their existing
order and append `payment_id`, `receipt_id`, `receipt_amount`, `receipt_currency`, `record_kind`.
`receipt_allocation` rows represent debt discharge, not another bank receipt. `legacy_payment`
rows retain the old meaning. An adapter must not post an allocation from both the payment CSV and
the settlement events. Issued invoice/credit events continue to own revenue and tax changes.

This foundation records exact source-currency facts. It does not infer base-currency carrying
values, realized FX gains/losses, processor-fee VAT deductions or reverse-charge treatment. The
existing Phase A `postingsFor` refuses these settlement events with `event_not_supported`.
Accounting adapters must apply a separately approved valuation/tax policy before posting those
components; they must not use an invoice's historical exchange rate as the bank receipt rate.

## Danish review boundary

Writeoff and discount commands always refuse with `accountant_review_required`, even when the
operator supplies evidence. The UI states that these routes are disabled. No accountant approval
has been obtained by this implementation.

Review fixtures for a qualified accountant are the 1000/985/15 DKK examples, the EUR-to-DKK
allocation with explicit source quantities, reversal followed by credit and refund, and a fee whose
VAT treatment is unknown. Before tax-affecting routes are enabled, the reviewer must decide fee
VAT evidence, discount tax-base changes, bad-debt eligibility and recovery treatment, and carrying
value/FX rules. Automated fixtures establish arithmetic and conservation; they are not accounting
approval or evidence from real customer books.
