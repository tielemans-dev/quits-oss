# Kvit settlement provenance UI handoff

Issue #32, backend candidate dated 8 October 2026. UX owns the Kvit identity and all new user-facing work. No screens, branding, invoice commands, document-view contracts, editors or PDF code change in this candidate. These are interaction requirements, not an approved visual design.

## Read data and labels

`payments.receipts({ invoiceId })` retains its existing fields and adds `provenance` and `history`. `provenance.recordedBy` is the original seller operator's actor key; `recordedAt` is an ISO timestamp. A manually recorded receipt starts as `received` with null `verifiedBy` and `verifiedAt`. A current bank/provider match supplies the verifying operator and timestamp. An applied return shows `returned`. The existing `reversed` field still identifies a financial correction. Do not label every manually reversed receipt a bank return.

`history` contains the original immutable settlement events in organization sequence order, including actor kind/ID, occurrence time, command ID, event type and payload. It contains allocation, classification, refund and reversal facts. Use these to show who corrected a receipt and the reason/evidence at that time. Do not replace the original recording attribution with the correcting person's name. Actor keys/IDs are durable audit identifiers; display a resolved name if available, with an honest fallback when the account is unavailable.

`payments.evidenceHistory({ contactId })` returns source transactions for the current organization only. Each has source kind, account/transaction references, current receipt link, source-created receipt ID, revision, state, processing review deadline, return-pending flag and complete ordered observations/decisions. Observations show source occurrence time separately from local recording time. Each preserves its actor key, command ID, reference, currency, net/fee amounts, fee evidence and any corrected/reversed observation ID. Decisions show the selected receipt, identity justification, reason, evidence and deciding operator/time.

Use distinct labels for:

- Reported by customer, recorded by operator. A report never reduces debt.
- Processing evidence, with its source, source time and review deadline. It does not say paid or pause reminders.
- Received according to seller, without bank/provider corroboration.
- Verified by operator against supplied bank/provider evidence. Do not imply signature validation, statement authenticity checks or irrevocable funds.
- Return evidence awaiting review when `returnPending` is true. Cash/debt has not yet changed.
- Return applied, with a link to the original receipt and the allocation/receipt reversals.
- Unmatched verification and corrected evidence, showing both the original and replacement facts and who made the decision.

A source's `returned` state describes its evidence. A receipt's `returned` state describes an applied reversal. Keep that distinction visible. Show currency with every quantity. Net received, processor fee, gross funding, invoice debt discharged, residual credit and refund are separate facts. Cross-currency allocations use their frozen receipt and invoice quantities; do not recalculate them using today's rate.

## Actions and review

The new contracts live at `@quits/contracts/settlement-provenance`.

1. `payments.recordEvidence` records source facts only. Preserve stable non-secret account, transaction and event/statement-row references across imports. Show entered source facts and operator attribution. The backend rejects a client-source state other than `reported`. New customer-facing report submission is a separate authentication and abuse-control task.
2. `payments.previewEvidenceDecision` accepts an action and returns its reviewed financial/evidence state and `previewToken`.
3. `payments.decideEvidence` accepts `{ decision, previewToken }`. Keep the same request ID only while retrying an unchanged uncertain response. After changing any decision field or receiving a stale-preview refusal, obtain a fresh preview with a new request ID.

`match` requires an existing receipt and explicit identity justification. Offer transaction reference, provider payment ID or remittance document. Require the identity value, explanatory reason and supporting URL. Amount and date can help a human inspect candidates but cannot authorize an automatic match. The source currency, net and fee must each agree with the receipt. Do not silently convert a mismatch into a fee, discount, writeoff or FX adjustment.

`confirm` creates a receipt from received bank/provider evidence after a person reviews its identity and quantities. It does not allocate debt. Reuse the parent money allocation workflow for that. When a receipt was already recorded manually, the action is to match it. Do not offer a new cash entry for an already matched source transaction.

`unmatch` removes current verification and leaves cash/allocations unchanged. Show that financial effect explicitly. Existing decisions stay in history. If the original cash itself was wrong, the operator must separately use the money correction workflow. A source that already created or verified a receipt cannot confirm another receipt until the original is reversed and its evidence explicitly corrected.

`return` requires returned evidence that names the original received evidence. If it arrived before manual matching, also supply explicit `identity` justification for the existing compatible receipt. A current receipt link cannot be redirected by a return. Preview the original net cash, fee and gross quantities, and every affected invoice allocation. Commit reverses all active allocations and the receipt in one transaction. Show the resulting debt reopening. Other receipts remain applied. Active refunds block this action until separately resolved. Partial returns, retained-fee returns, aggregated payouts and legacy payment adoption have no new action in this candidate.

Source corrections use `correctsEvidenceId` with a new event reference. The old observation stays visible. Correction requires `payment:void` and unmatching first; source-created cash also requires a financial reversal first. Do not edit the original evidence in place. Returned source evidence cannot be changed into new successful cash.

## Permissions and collections

Use existing payment permissions. Members can record observations and match/confirm receipts. Unmatching, corrections and returns require `payment:void`. Accountants can read history but cannot perform these mutations. The backend checks current membership in its transaction and refuses agents/system actors, including customer-link actors.

Processing guidance is informational. The deadline is at most 72 hours after the earliest processing source timestamp for that transaction. Reimports do not extend it, and expired guidance returns null. `automaticCollectionSuppression` is always false. Do not display or implement an automatic reminder pause based on this DTO. A future collection-timing decision needs explicit bounded rules and separate review.

Discounts and writeoffs remain disabled pending qualified accountant review. No pilot or customer validation supports declaring this workflow finished. The UI acceptance item remains deferred until UX implements and verifies these interactions. Targeted browser verification belongs with that later UI change.
