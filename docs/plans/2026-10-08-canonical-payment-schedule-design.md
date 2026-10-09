# Canonical Payment Schedule Design

Status: **proposed**, 2026-10-08. Discovery output for
[#25](https://github.com/tielemans-dev/quits-oss/issues/25). Nobody has approved this record yet:
it needs maintainer review, and the Danish tax questions at the end need a qualified Danish
accountant. It changes no runtime behaviour. The contract prototype is pure code in
`apps/oss/src/domain/payment-plans/`, tested but not wired into any command.

## Summary

Every instruction that decides how a customer is billed or asked to pay has exactly one canonical
owner, with append-only versions. Editors, invoice lines and automations store a reference to the
owner's current version, never a copy.

| What | Canonical owner | Version |
| --- | --- | --- |
| What the customer owes for fixed work | the agreement's accepted offer | `acceptedOfferRevision` and `offerSnapshotHash` |
| How that obligation becomes sale invoices or advance requests | the obligation's **payment plan** (`billing_steps` or `advance_then_billing`) | plan version |
| How one issued invoice's balance is collected over time | that invoice's **payment plan** (`collection_installments`); without one, the invoice's own due date | plan version |
| What a repeat service bills each period | the **recurring instruction** (today's `RecurringInvoice`) | instruction version |
| Permission to pull money from a saved method | a **collection authority** (not built; [#51](https://github.com/tielemans-dev/quits-oss/issues/51) decides) | authority version |

An obligation has at most one authoritative plan version. A plan version changes only by
compare-and-set on the current version, so two proposals built on the same version can never both
win. That is the rule that stops a 50/50 plan and a 30/70 plan for the same obligation from both
becoming authoritative.

## Current behaviour (audited at `7cf3ad9`)

- **Agreements, offer format v1** (no `offerFormatVersion`): a deposit line is part of the agreed
  total. A 300 deposit plus a 700 balance line is a 1,000 agreement.
- **Agreements, offer format v2** (every new draft): services and the payment schedule are priced
  separately. `serviceTotal` is the agreed amount; `paymentSchedule[]` lists the deposit lines
  (`isDeposit`) with trigger `on_agreement_acceptance` and requests money against that total.
- `invoice.create_from_deliverables` puts service lines on a `sale` draft and schedule lines on a
  `prepayment` draft. Issuing a prepayment invoice is refused with `purpose_issuance_not_supported`.
  `invoice.schedule_as_sale` records an explicit choice to invoice a schedule line as a sale.
- **Finding: the sale choice double-bills a v2 agreement.** In v2 the schedule line is not part of
  `serviceTotal`, and nothing deducts it from the later service invoices: linked lines are
  immutable and unit prices cannot be negative. Services of DKK 30,000 plus a DKK 9,000 schedule
  line (DKK 37,500 and DKK 11,250 with 25% VAT) invoice DKK 48,750 against an agreed DKK 37,500 if
  the schedule line is invoiced as a sale and then every service line is invoiced. The migration
  reports this as `double_count_exposure` or `double_counted`. This record does not change the
  command; the parent decides whether to guard it before the advance work lands.
- Public checkout opens one Stripe session for the whole remaining balance.
- Reminders are keyed to the invoice's single due date (`InvoiceReminder.offsetDays`).
- `RecurringInvoice` has no link to an agreement. A run prices its items **at run time with the
  organization's current prices-include-tax setting**, so changing that setting silently changes
  the amount of every future run.
- There is no plan, plan version, consent record, advance ledger or saved-method authority.

## Vocabulary

- **Obligation**: what the customer owes for what. An accepted agreement's billable scope, or an
  issued invoice's payable gross. Each period of a recurring instruction is its own obligation.
- **Billing step**: one sale invoice of an agreement obligation. It bills either one scope
  deliverable at its frozen line values (today's mechanism) or a **share** of the whole obligation,
  never both in one plan.
- **Advance**: money requested before the sale, held for the customer, applied to the next sale
  invoice of the same obligation or refunded. Not revenue.
- **Collection installment**: a dated part of one issued invoice's payable balance. Collecting in
  installments creates no new tax document and changes no invoice field.
- **Recurring instruction**: a repeat service. It generates invoices; it never collects money.
- **Collection authority**: a payer's permission to charge a saved method within a scope.
- **Three pauses that never imply each other** (collision C7): a *generation pause* stops a
  recurring instruction creating invoices (today's `RecurringInvoice.status = paused`); a
  *communication pause* stops reminders and messages (today's `Invoice.remindersPaused`); an
  *authority suspension or revocation* stops charges. Pausing one never pauses another.

### Invoice corrections and obligation reductions

An **invoice correction** reverses a document without forgiving the agreed debt. An
**obligation reduction** is an explicit concession that forgives part of that debt. A credit
note can contain either or both; the amount credited alone does not identify the business effect.

The position prototype accepts each invoice's cumulative `creditedMinor` and the subset
`obligationReductionMinor`. The latter defaults to zero, so a credit never silently forgives
debt. This subset belongs to the supplied original obligation version. Do not carry it forward
again after an agreement revision already incorporates the reduction. A future persistence
adapter must preserve the concession evidence and translate that revision explicitly.

For an agreed DKK 100.00, fully crediting the original DKK 100.00 invoice and issuing an unpaid
replacement leaves DKK 100.00 receivable and DKK 100.00 remaining. Without the replacement,
DKK 100.00 remains uninvoiced. Crediting DKK 25.00 as a concession leaves DKK 75.00 payable,
receivable and remaining. A full concession leaves zero payable and prevents a replacement
from rebilling the forgiven debt. Tests execute all four cases. Corrected invoices retain their
original receipts; an overpayment on one invoice and debt on its replacement remain separately
visible until a later posting resolves them. The prototype does not transfer or refund direct
invoice payments.

`taxMinor` is the original invoice tax. Full credits reverse it in full. Partial credits require
`creditedTaxMinor` from the frozen credit calculation; the prototype does not guess a tax rate.
These invoice credits do not decide the tax treatment of advances, which still belongs to #24.

## Which instructions may coexist

| Combination | Relation | Rule |
| --- | --- | --- |
| Two billing plans for one agreement obligation | duplicate | Refused: one plan per obligation; the second must be an amendment of the first. |
| Billing plan and a collection plan on one of its issued step invoices | layered | Allowed: the collection plan schedules one document's balance. |
| Two collection plans for one invoice | duplicate | Refused. |
| A billing plan on the full obligation and a collection plan on a full-price invoice for the same obligation | duplicate | Refused at source: an invoice for the obligation must reference a plan step, so a full-price invoice outside the plan cannot be issued. |
| Fixed project plan and a separate recurring support instruction | independent | Allowed: different obligations. |
| A recurring instruction used to pay off a fixed obligation | duplicate | Refused (`recurring_cannot_split_fixed_obligation`): use billing steps with dated triggers. |
| Plan or recurring instruction and a collection authority scoped to it | layered | Allowed: the authority never changes amounts or documents. |
| Two active authorities for the same scope | duplicate | Refused. |
| Advance and billing steps for one obligation | one plan | The `advance_then_billing` arrangement; advances apply to the next sale invoices in plan order. |

`coexistence.ts` encodes the pairwise rows and `coexistence.test.ts` runs them. The full-price
invoice row is enforced by step references (`obligationPosition` refuses an invoice outside the
plan), and the advance row by the arrangement schema.

## Invariants

1. One authoritative plan per obligation. Persisted: one plan row per obligation, unique on the
   obligation; versions append-only; `currentVersion` changes only by compare-and-set inside the
   obligation's existing document lock (`lockDocument("agreement" | "invoice", id)`).
2. A version names the exact obligation version it was built from. A different offer revision or
   offer hash, or a different issued artifact hash, is `stale_obligation_version`.
3. Billing steps bill the obligation exactly once: `Σ steps = accepted total − cancelled scope`.
   A v2 payment-schedule line can never be a billing step.
4. Advances never exceed the billable obligation and are never revenue. A receipt is for an invoice
   or for an advance, never both. Applied plus refunded advance money never exceeds what was
   received; applications to an invoice never exceed its credited balance less direct payments.
5. Collection installments total the invoice's payable gross, with strictly increasing due dates
   no earlier than the issue date.
6. Issued invoices, paid installments, received advances and prior acceptance evidence never
   change. A plan edit that would change them is refused; corrections use credit notes, refunds or
   a new agreement revision ([#42](https://github.com/tielemans-dev/quits-oss/issues/42)).
7. A sale invoice from a plan stores `{ planId, version, stepId }`. One live invoice per step; a
   fully credited step invoice may be replaced by one new invoice for that step only when this
   does not rebill an obligation reduction.
8. Automations reference the current version; they never propose one (`automation_cannot_amend`).
   Agent proposals follow the existing approval rules for outward-facing commands.
9. Money is integer minor units at the currency's exponent (0 to 2). Sub-minor input is refused,
   never rounded. A plan uses its obligation's currency; a currency change is a new obligation.

## Rounding

The settlement precision rules belong to
[#23](https://github.com/tielemans-dev/quits-oss/issues/23) (collision C5). This design adds no new
rounding rule; it reuses the two the ledger-ready money model already fixed:

- **Ratios to amounts:** a ratio plan (for example 50/50 or three thirds) is resolved once, when the
  version is created, by cumulative half-up rounding. Each share is the difference of two rounded
  cumulative entitlements, so the shares total exactly and the last absorbs the residual:
  DKK 100.00 in thirds is 33.33, 33.33, 33.34. The stored version holds only exact minor units.
- **VAT composition of a share:** each share is spread over the obligation's frozen VAT groups by
  their remaining gross (largest remainder, group order breaks ties); within a group, tax and
  payable rounding follow the credit-note cumulative entitlement rule (`creditComponents`). The
  shares together reproduce every frozen group component exactly, including inclusive-price
  payable rounding.

### Position snapshot validation and conservation

`positionInputSchema` parses every amount before arithmetic. The calculator then validates the
plan against the exact obligation owner, revision or artifact, currency, steps and totals.
The caller must obtain the authoritative plan and settlement snapshot atomically. A pure
calculator cannot discover a newer database version; `checkPlanRef` and the existing adoption
compare-and-set checks remain required at command boundaries.

Invoice ids and receipt ids must be unique. Applications are cumulative totals keyed by the
receipt/invoice pair; refunds are cumulative totals keyed by receipt. These arrays are not
append-only event feeds. An adapter must deduplicate posted events by their ledger identities
before aggregation. Duplicate aggregate keys, missing targets, malformed or negative amounts,
zero receipt/application/refund amounts, excessive credits, and reductions exceeding credits
are refused. Only advance receipts can fund applications and refunds here. An application
must name an invoice in this obligation and fit its unpaid balance after direct payments.
Advance overpayments may remain available and are reported explicitly; they are not revenue.

For every successful snapshot:

- Received advances equal applied advances plus refunded advances plus available advances.
- Payable obligation equals billable gross less explicit obligation reductions.
- Remaining equals payable obligation less direct receipts less advances retained after refunds.
- Remaining also equals uninvoiced plus invoice receivables less invoice overpayments less
  available advances. Applications move money between buckets without changing remaining.

Concessions cannot exceed their credited amounts, and net invoices plus concessions cannot
exceed a step's amount. Partial correction and rebilling with changed scope require an explicit
agreement/plan revision; this prototype only replaces an entire credited step at its original
amount. It does not infer a scope amendment from a credit note.

## Versions, concurrency and consent

- **Version 1** of an agreement plan is the schedule the customer accepted with the offer
  (`source: agreement_offer`, consent `offer_acceptance` of that revision), or the migrated
  equivalent. An invoice has an implicit plan, collection in full on its due date, which is never
  stored; its first collection plan is version 1 and amends that implicit plan.
- **Amendments** carry `expectedVersion` (the version the proposer saw) and, for collection plans,
  the paid amount the proposer saw. A mismatch is `stale_plan_version` or `stale_settlement`.
- **Consent rule (dominance).** An amendment needs recorded customer consent unless, at every
  point in time, the new version asks for no more money than the current one. Deferrals and
  reductions are adopted with a notice. Dates compare by calendar. A deliverable event happens on
  or after the obligation became binding, so a date is no later than an event due `n` days after it
  when the date is no later than the binding date plus `n`. An event precedes another event only
  on a superset of its deliverables at the same or later stage and term, and never precedes a
  fixed date. Moving money between a fixed date and a deliverable event therefore needs consent in
  either direction: the event may come earlier or later than the date. The check is conservative:
  when the order of two due points cannot be known in advance, it assumes the new one may come
  first.
- An amendment needing consent waits as the single **pending** version; the current version stays
  authoritative. Nothing else may amend the plan until the pending version is consented or
  withdrawn. Recording consent rechecks issued steps, receipts and payments, because they may have
  changed while the customer was deciding. Withdrawn version numbers are never reused.

## Effect of a plan edit

| Item | Effect |
| --- | --- |
| Draft invoice of a changed or removed step | Listed for regeneration: release its reservation and rebuild it from the new version. Drafts of unchanged steps stay. |
| Issued invoice | Never changed. Editing its step is refused (`issued_step_immutable`). |
| Paid installments | The paid amount, allocated to installments in due order, forms settled pieces. A new collection version must start with those pieces at their original dates and amounts (`paid_installment_immutable`). |
| Received advance | Cannot be reduced below what was received or removed (`received_advance_immutable`); refund instead. |
| Reminders | Unsent reminders of changed or removed targets are listed for rescheduling. Installment reminders key to the installment due date ([#46](https://github.com/tielemans-dev/quits-oss/issues/46)). |
| Accepted terms and evidence | Kept. The superseded version and its consent stay in history. |
| Public payment links | Links for changed targets must re-resolve the amount from the current version when a checkout session is opened ([#40](https://github.com/tielemans-dev/quits-oss/issues/40)). |
| Recurring runs | Runs before the effective date keep their version. Issued runs on or after it refuse the change; drafts on or after it are listed for regeneration. The next three runs are previewed under both versions with the recurrence executor's own date functions. |
| Collection authority | Re-pointed at the new version; renewal required when a charge exceeds the authorized maximum, charges come closer together than authorized, a charge depends on an event, or the currency changes. |

## Controlled exceptions

A draft raised from a billing step may differ from its step only in terms that neither move money
earlier nor redistribute the obligation:

- a **later** due date, with a recorded reason (`later_due_date` exception on the draft);
- notes, references and purchase-order fields;
- extra unlinked lines, which bill a **separate obligation** (expenses, extra hours) and are not part
  of the plan's totals.

A different linked amount is a plan amendment (`amount_requires_plan_amendment`), never an
exception. An earlier due date needs recorded customer consent (`earlier_due_requires_consent`).
An exception never creates a second plan. `classifyStepDraft` implements the rule.

## Worked examples (DKK, 25% VAT on top of the net price)

`__tests__/worked-examples.test.ts` runs all three.

### A. Fixed-price website, two sale invoices of 50%

Agreement AGR-1 accepted 1 October 2026: website, DKK 20,000.00 net.

| | Amount |
| --- | --- |
| Obligation: AGR-1 revision 1, services | DKK 25,000.00 (20,000.00 + VAT 5,000.00) |
| Plan v1, `billing_steps` | `first_half` on acceptance, due in 14 days: 12,500.00. `second_half` on acceptance of the website, due in 14 days: 12,500.00 |

| Event | Document | Invoiced | Paid | Uninvoiced | Receivable | Remaining |
| --- | --- | --- | --- | --- | --- | --- |
| Acceptance | INV-0001 (sale) 12,500.00 = 10,000.00 + VAT 2,500.00 | 12,500.00 | 0 | 12,500.00 | 12,500.00 | 25,000.00 |
| Card payment | | 12,500.00 | 12,500.00 | 12,500.00 | 0 | 12,500.00 |
| Website accepted | INV-0002 (sale) 12,500.00 = 10,000.00 + VAT 2,500.00 | 25,000.00 | 12,500.00 | 0 | 12,500.00 | 12,500.00 |
| Bank transfer | | 25,000.00 | 25,000.00 | 0 | 0 | 0 |

Revenue 20,000.00 and VAT 5,000.00, each counted once. An automation trying to attach a 30/70
plan is refused; a seller amending to 30/70 before INV-0001 is issued asks for less money sooner
and is adopted with a notice; amending to 70/30 asks for DKK 5,000.00 more by 15 October and waits
for consent. After INV-0001 is issued at 12,500.00, any version changing `first_half` is refused.

### B. Fixed-price service with a 30% advance

Agreement AGR-2 accepted 1 October 2026: brand identity, DKK 40,000.00 net.

| | Amount |
| --- | --- |
| Obligation | DKK 50,000.00 (40,000.00 + VAT 10,000.00) |
| Plan v1, `advance_then_billing` | Advance on acceptance, due in 7 days: 15,000.00. Sale step on acceptance of the identity: 50,000.00, with advances applied to the next sale invoice |

| Event | Document | Advance held | Invoiced | Applied | Receivable | Remaining |
| --- | --- | --- | --- | --- | --- | --- |
| Acceptance | Advance request; its document type waits for #24 | 0 | 0 | 0 | 0 | 50,000.00 |
| Bank transfer 15,000.00 for the advance | | 15,000.00 | 0 | 0 | 0 | 35,000.00 |
| Identity accepted | INV-0003 (sale) 50,000.00 = 40,000.00 + VAT 10,000.00, advance 15,000.00 applied | 0 | 50,000.00 | 15,000.00 | 35,000.00 | 35,000.00 |
| Card payment 35,000.00 | | 0 | 50,000.00 | 15,000.00 | 0 | 0 |

The same balances result when the advance is paid by card and the rest by bank transfer. A partial
application of 10,000.00 leaves 5,000.00 visible as available advance; applying the same receipt
beyond 15,000.00 is refused. The proportional VAT inside the advance would be 3,000.00 and inside
the rest 7,000.00, which together equal the 10,000.00 on the sale; whether and when that 3,000.00 is
due on receipt is question 1 below, not a decision here.

### C. Separate recurring support

Recurring instruction REC-1 v1: support DKK 1,500.00 net monthly from 1 November 2026, due in 14
days, drafts only, manual collection.

| Run | Document | Amount | Paid | Open |
| --- | --- | --- | --- | --- |
| 2026-11-01 | INV-0004 | 1,875.00 (1,500.00 + VAT 375.00) | 1,875.00 by bank transfer | 0 |
| 2026-12-01 | INV-0005 | 1,875.00 | 0 | 1,875.00 |

Each run is its own obligation; REC-1 never touches AGR-1's plan, and a recurring instruction that
claims AGR-1 is refused. Raising the price to DKK 1,800.00 net (2,250.00 gross) from 1 January 2027
keeps INV-0004 and INV-0005 unchanged, rebuilds a January draft if one was already generated,
previews the next three runs at 2,250.00, and requires customer consent. Switching collection to
a saved method is refused as an amendment: it needs an authority and its own consent.

### Recurring term amendments

Consent checks use the agreed term independently of the displayed preview count. Extending an
end date, removing a finite end, adding runs beyond the remaining agreed count, or restarting
an instruction with no remaining runs requires consent. Switching between a date limit and a
count limit also requires consent conservatively, even when the first few dates match. A later
end date requires consent even if the cadence produces no extra run in that small extension.
An unchanged or shortened date limit, a reduced remaining count, or adding a finite end to an
open-ended instruction needs no term consent. Price, cadence and earlier-payment checks still
apply separately.

An anchor or cadence change also requires consent when the amended instruction has future runs.
The prototype does not prove that every future payment stays on or after its old date for a
changed calendar phase. For example, moving a monthly anchor from 31 January to 30 January leaves
the first November run on 30 November, but advances the December run from the 31st to the 30th.
This check is conservative and independent of how many runs the preview displays.

`after_runs` counts from each version's `effectiveFrom`, including authorized periods whose
invoices have not yet been generated. For October through December with a count of three, a
November amendment must specify two remaining runs to retain the December end. Keeping three
adds January and requires consent. A new run after either a date or count limit has expired is
a restart, including when the new price is lower. Historical instructions and issued invoices
remain unchanged; the new instruction identifies governed drafts for regeneration. These rules
are a conservative proposal, pending legal review. Term consent also requires renewal of any
saved-method authority; it never enables charging by itself.

Authority interval checks also ignore the displayed preview count. They check actual UTC run
dates using the executor's cadence and anchor clamping. A finite date or count limit ends the
check at the last authorized run, so a short month after that limit does not require renewal.
For an open or longer term, monthly and yearly checks stop only when the run's Gregorian year
modulo 400, month and day repeat. The Gregorian calendar repeats every 400 years, and the fixed
cadence and anchor then produce the same intervals again. This proves coverage of all later
intervals, including leap years, non-leap centuries and restored month-end anchors. Weekly
intervals are constant, so one interval proves their spacing. There is no sampled invoice
horizon. A single remaining charge has no interval to check. Currency and the fixed charge
amount are checked separately, and the authority still needs an explicit version reference.

## Recurring generation versus saved-method charging

Generation creates and optionally sends an invoice. Charging pulls money. They are separate
records and separate failures. A recurring instruction has `delivery` (`draft_only` or
`auto_send`) and `collection` (`manual` today). Turning on `auto_send` keeps the existing agent
approval rule. `collection: saved_method` can only reference an existing authority and is never
enabled by a schedule edit.

The authority boundary (`collectionAuthoritySchema`) records what a future implementation must
honour. #51 owns the demand, provider and go/no-go decision; this record commits no build.

- **Consent and mandate:** evidence of the payer's agreement, the scope (one plan version or one
  instruction version), currency, maximum single charge and minimum interval.
- **Changed amount or cadence:** an amendment beyond scope requires renewal before the next charge.
- **Revocation and expiry:** stop future charges only; generation and reminders continue.
- **Idempotency:** one charge attempt per installment or run, keyed by plan or instruction version
  and target; an uncertain provider result blocks a second attempt until resolved.
- **Customer pays manually first:** the scheduled charge for that target is cancelled by the
  settlement, never attempted.
- **Failed-charge recovery** is its own state (retry, authentication needed, method replaced), not a
  communication pause or a generation pause.

## Migration

`migration.ts` is a report-only classifier over today's rows. It never changes a row.

1. **Dry run.** For each accepted agreement, read the row, its deliverables, its linked invoices and
   the stored offer snapshot through `readAgreementOfferSnapshot`; produce version 1 with
   `source: migration` and the original acceptance as consent, plus findings. Report per
   organization; owners review every `review` and `blocking` finding.
2. **Additive tables.** Add the plan and version tables, the step reference on invoices and the
   instruction version on recurring schedules. Backfill version 1 for agreements without blocking
   findings, `stepId` equal to the deliverable id so existing linked invoices map 1:1. Backfill
   recurring instruction version 1 from each active or paused schedule.
3. **Read through references.** Editors, `invoice.create_from_deliverables` and the recurrence
   executor read the current version. The reservation rules of the agreements design stay.
4. **Enforce.** Refuse linked invoices without a current plan step; freeze the recurring period
   amount in the instruction and make a prices-include-tax change an explicit amendment.

| Current data | Migrated as | Finding |
| --- | --- | --- |
| v1 deposit line in the total | billing step due on acceptance (`source: deliverable`) | `v1_deposit_in_total` (info) |
| v1 deposit on a `prepayment` draft | the step's draft | `v1_prepayment_draft_bills_scope` (review): it bills part of the price; invoice it as a sale by explicit choice; never converted automatically |
| v2 payment-schedule line | advance of `advance_then_billing`, gated on #24 | `v2_schedule_is_advance` (info) |
| v2 `prepayment` draft | the advance's draft; issuance stays blocked | `prepayment_draft_remains_blocked` (info) |
| v2 schedule line invoiced as a sale | outside the plan | `v2_schedule_invoiced_as_sale` (review) and `double_count_exposure` (review), or `double_counted` (blocking) when issued sales already exceed the service total |
| Cancelled line | excluded from the steps | `cancelled_line_excluded` (info) |
| Unaccepted agreement | no plan until acceptance | `not_accepted` (info) |
| Unreadable snapshot, drifted lines, unsupported currency | none | blocking |
| Recurring schedule | instruction version 1, period amount priced by today's run function and setting | `recurring_price_follows_settings` (review), `generation_is_not_collection` (info) |

The fixtures in `migration.test.ts` are synthetic rows in today's shapes. They are not evidence
from a real organization's data.

## Persistence sketch for implementers

Not applied; names are proposals.

- `PaymentPlan(id, organizationId, obligationKind, agreementId?, invoiceId?, currentVersion?,
  pendingVersion?, nextVersion)`, unique on `agreementId` and on `invoiceId`.
- `PaymentPlanVersion(planId, version, supersedes?, obligationRef Json, currency, arrangement Json,
  source, actorKey, reason?, consent Json?, outcome, createdAt, decidedAt?)`, primary key
  `(planId, version)`. `arrangement` is validated by `arrangementSchema` on write and read.
- `Invoice.paymentPlanId`, `paymentPlanVersion`, `paymentPlanStepId`, with a reservation row per
  step like deliverable reservations, so one live invoice per step holds under concurrency.
- `RecurringInstructionVersion(recurringInvoiceId, version, ... instruction fields)` and
  `Invoice.recurringInstructionVersion`.
- Events `payment_plan.version_proposed`, `payment_plan.version_adopted`,
  `payment_plan.consent_recorded`, `payment_plan.version_withdrawn`. They carry no money postings.

## For the dependent issues

- **[#41](https://github.com/tielemans-dev/quits-oss/issues/41) advance payments**: use
  `advance_then_billing` and `obligationPosition`. Receipts declare `for: advance`; applications
  are explicit, bounded per receipt and per invoice, and record source receipt and target invoice.
  Keep the prepayment issuance block until #24 decides the documents.
- **[#46](https://github.com/tielemans-dev/quits-oss/issues/46) invoice installments**:
  `collection_installments` on the invoice obligation, `settledPieces` for paid parts, the
  dominance rule for consent, `expectedPaidMinor` against concurrent payments. A credit note
  changes the payable gross, so it needs a new collection version (`source: credit_rebase`);
  reducing the latest unpaid installments first keeps near-term dates stable and never needs
  consent.
- **[#40](https://github.com/tielemans-dev/quits-oss/issues/40) partial checkout**: a scheduled
  amount comes from the current version's next unpaid installment or step; a stale link re-resolves.
- **[#42](https://github.com/tielemans-dev/quits-oss/issues/42) amendments**: changing scope or fee
  is a new obligation version; the plan is then rebased with issued steps preserved.
- **[#34](https://github.com/tielemans-dev/quits-oss/issues/34) recurrence preview**:
  `previewRuns` already uses the executor's date functions; the user-facing preview and the
  catch-up and pause rules stay with #34 (collision C2).
- **[#51](https://github.com/tielemans-dev/quits-oss/issues/51)**: the authority boundary above.
- **[#58](https://github.com/tielemans-dev/quits-oss/issues/58) repayment agreements** span several
  invoices and are not modelled here; they would be a separate obligation kind over existing debt.

## Questions for a Danish accountant (input to [#24](https://github.com/tielemans-dev/quits-oss/issues/24))

None of these are answered here. The statute references are the ones the ledger-ready money model
already cites and must be verified.

1. When an advance is received, is VAT due on the received amount at receipt (momsloven § 23,
   stk. 3)? For a card payment, is receipt the customer's payment date or the processor's
   settlement date?
2. Must an invoice be issued for an advance received from a business customer, and from a consumer?
   May a payment request without a VAT breakdown be sent before receipt?
3. How must the final invoice show an applied advance: the full sale with total VAT and a deduction
   of the advance including its VAT, or another form? How should the electronic invoice carry it?
4. Is a share billing step issued before the service is delivered (for example 50% on acceptance) a
   sale invoice with an issue-date tax point, or a payment-on-account (a conto) invoice that should
   be treated like an advance? What supply date should it carry?
5. For an obligation with several VAT rates, may an advance or share be split across the rates in
   proportion, or must it be attributed to specific supplies?
6. Cancellation after an advance or a share invoice: which document corrects VAT, and how is a
   partial refund handled?
7. When the final sale is smaller than the advance received, is the excess a refund or a customer
   credit, and what is its VAT effect?
8. An advance in a foreign currency: which exchange-rate date applies to the VAT on the advance and
   on the final sale?
9. A recurring service invoiced at the start of its period: does the tax point follow the invoice
   date, and how should the service period be stated?
10. Confirm that rescheduling collection dates on an issued invoice has no VAT effect.
11. How long, and in what form, must plan versions and customer consent to changed payment terms
    be kept under the bookkeeping rules?

A legal (not accounting) question for later: whether a recurring price rise for an agreed service
needs the customer's consent or only notice under the customer's terms. The prototype requires
consent until that is answered.

## Open points

- The guard against the v2 schedule-as-sale double billing (see Current behaviour) is not decided.
- Combining an advance with more than one share step is allowed by the schema; whether the advance
  should apply to the first sale invoice or across all of them is for #24.
- Whether a customer-favourable amendment should still wait for acknowledgement before reminders
  use the new dates.
- A minimum installment amount, and whether a collection plan may have a zero-amount installment.

## Prototype

`apps/oss/src/domain/payment-plans/`: `model.ts` (schemas and refusal codes), `amounts.ts`
(minor units, ratio shares, VAT composition), `validate.ts`, `authority.ts` (adoption, consent,
references, exceptions), `amendment.ts` (edit impact and consent rule), `recurring-instructions.ts`,
`position.ts` (obligation balances), `coexistence.ts`, `migration.ts`. Each has tests under
`__tests__/`; `worked-examples.test.ts` runs the three examples above.
