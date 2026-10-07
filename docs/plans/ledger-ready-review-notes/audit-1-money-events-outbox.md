# Audit 1: money events and outbox (Codex, 2026-10-07, HEAD 267dc06)

Assessment: stored amounts support balanced postings for single-currency, single-rate invoices.
VAT classification, FX and Stripe settlement are incomplete. Event ordering per organization is
already transactional and gap-free (OrgSettings.eventSequence, events.ts:25, execute.ts:247);
what is missing is consumer position and delivery idempotency.

## Events emitted today
- invoice.draft_created / draft_updated / draft_deleted (invoices.ts:146/235/270)
- invoice.sent {number, recipient, emailSent} (invoices.ts:374, document-delivery.ts:87) = issuance
- invoice.email_unconfirmed {number, recipient, issued} = issuance when issued=true (document-delivery.ts:100)
- credit_note.issued {number, invoiceId, invoiceNumber, mode, reason, totalGross} (credit-notes.ts:107)
- invoice.credited (status notification, credit-notes.ts:120)
- payment.recorded {paymentId, number, amount, currency, method, balanceDue, paymentStatus, overpaidBy?} (payments.ts:191)
- invoice.paid (cumulative notification, payments.ts:207)
- payment.voided (payments.ts:450); payment.failed (payments.ts:388)
- recurring.invoice_generated (recurring.ts:489); quote.converted (quotes.ts:567); invoice.became_overdue (overdue.ts:90)
- No invoice.issued, no void/cancel invoice, no refund path.

## Gaps (priority order)
1. VAT semantics: pricing writes taxCategory "standard" always, taxCode null, one document-wide rate; taxRegime only eu_vat/us_sales_tax; UBL maps zero rate to exempt (ubl.ts:69). Need per-line vatTreatment + taxCountryCode + reason. Old docs: keep amounts, flag zero-tax lines for reviewed classification.
2. No org base currency, no FX rate/date/source at issue or payment (schema.prisma:154 currency is invoicing default only).
3. Event payloads are not self-contained: money is a mix of JS numbers and toFixed(2) strings (events.ts:40 JSON round-trip). Need versioned issuance/payment payloads with minor units + exponent + per-rate totals + dates + buyer ids. Must be captured in delivered, unconfirmed and no-email issuance branches.
4. Buyer snapshot omits taxId/taxIds although the contract supports taxIds (snapshots.ts:16, contracts documents.ts:18); country nullable; snapshot built at draft creation, not refreshed at issuance (invoices.ts:129). supplyDate column exists but not settable from invoice input (contracts invoices.ts:15).
5. Stripe: stores checkout amount_total gross, no balance transaction, no fee, no net, no payout (webhooks.ts:241, payments.ts:157). Refund path absent; payment.voided is local only.

## Outbox
- Ordering OK per org. No consumer cursor. No event pruning path, but organization deletion cascades events; append-only is convention not constraint (schema.prisma:576).
- Smallest change: EventConsumerCursor(organizationId, consumerKey, lastSequence) and EventConsumerDelivery(organizationId, consumerKey, sequence, status, externalVoucherId, lastError). External consumers need a remote idempotency key.
- Replay needs an opening reconciliation: lifecycle migration backfilled payments without events (migration 20261006120000 line 362).

## Posting ambiguities
- Per-line rounding in compute.ts:56 vs per-rate recomputation in ubl.ts:146 (0.02+0.02 net at 25%: stored VAT 0.02, UBL 0.01). Use stored line amounts.
- Amount-mode credit notes collapse into one "standard" line at the first line's rate (credit-pricing.ts:91): ambiguous for mixed rates.
- Three-decimal currencies rounded to two (pricing.ts:5, payments.ts:38).
- Overpayments retained but balanceDue clamps at zero (payments.ts:148, settlement.ts:25): ledger must derive customer credit from gross payments and credits.
