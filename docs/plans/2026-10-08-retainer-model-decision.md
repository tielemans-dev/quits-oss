# Retainer arrangements and validation plan

Decision record for [#59](https://github.com/tielemans-dev/quits-oss/issues/59), 8 October 2026.
Status: defer implementation pending customer evidence and qualified Danish accountant review.
No interview, pilot, accountant review or provider exchange occurred. The examples below are
invented to distinguish contracts. They are not observed customer demand or approved terms.

## Decision

Do not add one generic retainer balance. Treat reserved capacity, spendable monetary advance and
fixed recurring service fees as different arrangements. If evidence warrants a first follow-up,
test a narrowly specified monthly capacity agreement with no carryover, automatic overage or
saved-method charge. This is a proposed interview/pilot candidate, not an approved product.
Fixed-fee invoicing already has a recurrence foundation; monetary advances remain gated on #24.

The linked [Danish advance decision](./2026-10-08-danish-advance-accounting-decision.md) keeps
prepayment issuance blocked and proposes early tax invoices for demanded advances. The word
retainer creates no tax exemption, earned revenue, spendable balance or permission to debit.
A service fee can be taxable even if no work hours are used [R2]. A refundable open-ended credit
may fail the specified-supply test or require voucher analysis [R1].

## Runtime and integration evidence

Source/base audited: `c0f23c014d0502c44fab9b7ea8b7a748c6b5eee8`.

- [Recurring commands](https://github.com/tielemans-dev/quits-oss/blob/c0f23c014d0502c44fab9b7ea8b7a748c6b5eee8/apps/oss/src/domain/commands/recurring.ts)
  generate draft invoices and can enqueue sending. They do not reserve hours or provide an
  advance ledger. Prices are calculated during generation using then-current settings.
- [Agreement invoice commands](https://github.com/tielemans-dev/quits-oss/blob/c0f23c014d0502c44fab9b7ea8b7a748c6b5eee8/apps/oss/src/domain/commands/invoices-from-deliverables.ts)
  distinguish sale and prepayment drafts; explicit schedule-as-sale records a choice.
  [Invoice commands](https://github.com/tielemans-dev/quits-oss/blob/c0f23c014d0502c44fab9b7ea8b7a748c6b5eee8/apps/oss/src/domain/commands/invoices.ts)
  still block prepayment issuance. A schedule is not evidence of a capacity product.
- Read-only money #72, `295d00bbb856ec79c536e33888569a29592d52dc`, records receipt ownership,
  allocation, evidenced fees, reversals and external refunds. Reuse it for monetary facts;
  classification creates no funds. It does not establish advance VAT or FX posting policy.
- Read-only schedule #71, `9adf93f73147c9a78414fc561f05abe22bd30bcc`, supplies pure versioned
  obligation/plan/recurring concepts. Its consent and calendar checks are proposals, not live
  authority to charge. Monetary advance application and fiscal invoicing still need #24 integration.
- Read-only Denmark #66, `7f37ed6ed93ad0d072ada6911c2936fbbf67bd87`, requires original-document
  handoff evidence and qualified review of the bookkeeping boundary. Its electronic-delivery
  fixtures do not validate a retainer document.

No runtime imports, schemas, screens or changes to common indexes accompany this decision.
UX retains document-view contracts, invoice/quote editing, commands and PDF/render ownership.
Preserve numbering-at-issuance, frozen payment details, VAT groups and price basis.

## Three contracts, three statements to the buyer

These are plain-language sample terms to test, not legal templates. Dates and amounts are synthetic.

| Arrangement | Buyer-facing example | Unit and obligation | What remains after the period |
| --- | --- | --- | --- |
| Reserved capacity | "For October we reserve up to 10 hours of design support for DKK 10,000 plus DKK 2,500 VAT. The fee pays for availability during October. You may request work within the agreed scope and lead time. Unused October capacity does not carry forward. Work above 10 hours requires a separate approved order." | 600 minutes of availability for 1–31 October in Europe/Copenhagen, plus the actual scope/response commitments | No automatic hour or cash credit. A failure by the supplier to provide the promised availability needs a correction/refund decision. |
| Spendable monetary advance | "You pay DKK 15,000 toward the identified DKK 50,000 project. Each application will appear on the project reconciliation. Unused refundable money is returned under the agreed cancellation terms; it does not expire automatically." | DKK minor units, linked to one accepted project revision and its tax treatment | Remaining gross customer entitlement, with distinct net performance liability and previously assessed VAT. No hour bank. |
| Fixed recurring service fee | "We provide the listed website maintenance service for DKK 1,500 plus DKK 375 VAT each calendar month. The fee covers that month's service. It does not buy a bank of hours or funds toward another project. Extra projects need a separate agreement." | One defined service period for a fixed fee; hours may be internal cost information only | Neither unused hours nor monetary credit, unless a documented correction creates one. |

The capacity agreement must specify availability windows, eligible tasks, response versus
completion commitments, booking lead time, supplier holidays, customer prerequisites and what
happens when both parties request the last hour. "10 hours" alone is insufficient contract scope.
Reserved capacity must not be sold twice across customers; a future feature needs a separate
supplier-capacity check, not just per-customer counters.

A hybrid must price and identify its parts. For example a capacity fee plus a project advance
cannot share one number called remaining retainer. Keep their contracts, money and obligations
separate. Defer hybrid implementation until customers demonstrate that simpler arrangements fail.

## Financial treatment and VAT boundary

Proposals in this section need a Danish VAT-experienced accountant. VAT timing and revenue
recognition are separate. A tax invoice or receipt can make VAT due before the corresponding
service is earned. Revenue timing must follow the actual contract and applicable accounting basis.

| Fact | Capacity | Monetary advance | Fixed recurring fee |
| --- | --- | --- | --- |
| Contract accepted | Agreed availability, no assumed cash receipt | Agreed specified future supply, no received funds | Agreed period service, no received funds |
| Invoice before service / money first | Apply reviewed invoice/advance tax-point rules; consider deferred revenue for unperformed availability | Use #24's one funding identity and tax assessment; receipt is not revenue | Apply same tax-point review for pre-invoiced or prepaid periods |
| Service performed | Availability can itself be a supply even if the customer uses zero hours [R2] | Apply entitlement only to actual covered supply; release liability, no second receipt/VAT | Recognize the contracted period service under approved policy |
| Non-use | Not automatically a discount, refundable balance or VAT reversal | Does not erase unused funds; classification/expiry needs separate assessment | Does not alone prove failure to supply |
| Cancellation | Determine what availability was provided and any compensation; no blanket forfeiture or VAT exemption [R3] | Credit/refund and entitlement reconciliation from #24 | Correct unprovided periods or disputed service with evidence |
| Bookkeeping handoff | Period invoice/payment, any deferred-revenue release and correction, with original document | Advance invoice/receipt/application/refund mapping from #24, never a second credit ledger | Period invoice/payment and correction, with original document |

R2 discusses C-463/14, where a provider stood ready under an advisory subscription and VAT was
not dependent on actual use. It does not decide every reserved-hours contract. The same guidance
rejects treating one-off services paid in installments as continuous supplies. R3 distinguishes
cancellation damages from taxable consideration and includes the contrary C-622/23 outcome for
work begun. Neither "non-refundable" nor "reservation" settles that analysis.

### Representative period reconciliations

Capacity example: 600 minutes reserved, 390 minutes used, 210 unused at period end. The contract
fee stays DKK 12,500 gross if the promised availability was supplied. There is no automatic
DKK 4,375 cash credit from multiplying unused hours by a rate. If the supplier could not supply
180 promised minutes, the owner must resolve the breach under agreed terms; a separately agreed
DKK 3,000 net reduction would require VAT/document correction, not deletion of capacity history.

Monetary example: DKK 15,000 received = 10,000 applied + 2,500 refunded + 2,500 still available.
That equation concerns gross entitlement, not net revenue. Under a 25% identified-supply advance
assumption, remaining 2,500 corresponds to 2,000 net advance and 500 previously assessed VAT.
Do not create 2,500 new funds when an operator labels the residual customer credit.

Fixed-fee example: October DKK 1,875 and November DKK 1,875 are two service obligations. If
October is paid and November is unpaid, cash is 1,875 and receivable is 1,875. The total of the
invoices is 3,000 net plus 750 VAT, subject to the approved tax dates and revenue-period policy.
Unused October staff time does not reduce November's invoice.

The fixture probe checks these quantities, but not supply performance, legal entitlement or
accounting recognition. No real customer case was obtained.

## Explicit term decisions

These decisions describe the proposed first pilot scope, all still conditional on validation.

| Term | Decision | Reason and required behavior |
| --- | --- | --- |
| Capacity unit | Accept minutes internally; display agreed hours | Use integer minutes, original entries and corrections; agree whether preparation/meetings count. No automatic currency conversion. |
| Period | Accept calendar month in named timezone | Inclusive start, exclusive next-month start. Preserve DST/calendar boundaries; agree booking cutoff and late time-entry handling. |
| Capacity carryover | Defer | Requires vintage, expiry order, maximum balance, interaction with new capacity and supplier commitment. No silent accumulation. |
| Capacity expiry | Accept only expiry of the contractual right to use that period's availability | Needs clear accepted terms and actual supplier availability. Never silently expire monetary funds. Record unused capacity without inventing work. |
| Automatic overages | Reject for first scope | Stop at available capacity; any excess requires separate price, scope and customer approval before work. Do not debit a saved method for excess. |
| Separately agreed overage order | Accept as an ordinary separate obligation if evidence supports it | State net price, VAT, ceiling and approval. Avoid billing both the included minutes and the same minutes again. |
| Refundable monetary balances | Defer feature to reviewed #24 scope | Preserve customer ownership and refund rights; no duplicate retainer ledger, inferred breakage or expiry revenue. |
| Non-refundable monetary breakage | Reject as a default | Requires contract/voucher/tax and consumer-law review beyond this candidate. |
| Supplier failure / early termination | Require human correction and reason | The no-carryover term cannot erase a breach or force payment for an unprovided obligation. Document refund/VAT decisions. |
| Automatic renewal or price increase | Defer unless already explicitly accepted for a finite pilot | Material scope, price, cadence or term changes need a new accepted version. Business-contract consent and debit authority are separate. |
| Cross-currency capacity credit, pooling, transfer, resale | Defer | No validated need; currency, ownership, tax and liability obligations differ. |

The future money balance must conserve `received = applied + refunded + available`. A refund
pending at a provider also reserves the relevant available amount so another action cannot spend
it. Capacity conserves `granted = used + expired + carried + remaining`, with reversals and
supplier adjustments explicitly represented. The two equations never share a unit or a balance.

## Interviews and pilot protocol, not completed

Customer evidence is currently **zero verified interviews and zero pilots**. Competitor help
articles and the issue's bookkeeping question are prompts for discovery, not interview findings.
The parent owns recruitment, contact, consent and scheduling; this worker contacted nobody.

Proposed recruitment: at least six Danish service firms, two currently using each arrangement,
plus one Danish accountant who sees more than one such business. Include owners and the person
who reconciles payments. Avoid recruiting only users who already call their arrangement a
retainer. Count a firm once even if it supplies multiple staff interviews.

For each 45-minute interview:

1. Obtain permission to record notes and view a redacted real contract, latest invoice, prior
   period's usage record and one correction. Record what was unavailable rather than filling gaps.
2. Ask the participant to explain what the buyer purchased before showing the three model labels.
   Identify unit, period, availability obligations, refund rights and whether money is earmarked.
3. Reconstruct the last actual month. Record minutes, invoice amounts, receipts, carryover,
   overages, disputes, refunds, system handoffs and time spent correcting them. Separate recalled
   estimates from measured records. Ask for a counterexample where the arrangement worked well.
4. Test zero use, exhausted allowance, supplier absence, mid-period cancellation, late entries and
   a customer asking to move value to another project. Ask which contract clause resolves each.
5. Show the three sample buyer statements in rotating order. Ask the participant to restate the
   terms and identify any incorrect promise. Record interpretation verbatim with consent.
6. Ask which existing workflow would be replaced, what would remain in e-conomic, the actual
   buying decision and willingness to join a limited pilot. Do not count polite interest as demand.

Use one evidence record per firm with interview date, participant role, arrangement, redacted
source references/hashes, exact quotations, measured pain and uncertainty, contrary observations,
permission scope and deletion/retention agreement. Keep identifying customer materials outside
public OSS; publish only authorized anonymized findings. No records exist from this protocol yet.

Go criterion for a separate implementation issue: at least three independently evidenced firms
share the same supported job and terms, two agree to a limited pilot, and the accountant signs
an exact scope/fixture revision. If only fixed-fee recurrence solves their problem, reject a new
capacity feature and improve the existing workflow through its owner. If needs conflict on
carryover or refunds, keep the feature deferred; do not average incompatible contracts.

Proposed pilot after those gates: two consenting firms, two complete calendar periods each,
manual collection, one arrangement per agreement and named owner approval of every invoice.
Baseline measured reconciliation time comes from the previous two periods. Record every period
including failures and exits. Proposed success measures, not observed outcomes:

- All pilot invoices reconcile to accepted terms and money records with zero unexplained cents.
- Zero duplicate invoicing, unauthorized overages or expired monetary funds.
- At least 90% of period statements need no correction before customer acceptance; report both
  numerator and denominator because four periods alone cannot establish a durable rate.
- Each firm reduces measured close/reconciliation effort by at least 30% versus its own baseline,
  without extra unrecorded accountant work. Failure on either firm is visible.
- Customer and accountant can independently explain unused capacity versus refundable funds.

Stop a pilot immediately for a wrong charge, lost correction trail or disputed entitlement;
resolve it manually with the owner and accountant. Stopping collection does not erase invoices,
service obligations or required records. No production pilot is authorized by this document.

## Kvit handoff and implementation boundary

UX should test explicit arrangement names and buyer statements before any new screen. Show the
period, what was purchased, unit, usage history, remaining entitlement and expiry rule together.
A capacity balance must display hours/minutes; monetary advance must display currency and tax
history; a fixed fee should not display a fictional remaining balance. Show an approved overage
order separately from included work. Corrections should show old/new terms and their reason.

A conditional follow-up must name the validated customer job, approved term set, review evidence,
pilot firms' consent and measurable outcomes above. For capacity it would need append-only usage,
period/version ownership and concurrent exhaustion protection in backend/contracts/tests, then a
separate UX assignment. Reuse agreement/billable work and #71 rather than competing schedule
owners. Monetary work depends on #24 and #72. Saved-method collection, if ever desired, depends
on #51 separately. No such implementation issue was created or approved here.

## Sources and acceptance

All official sources below were read on **2026-10-08**, with the guide pinned to 2026-2,
`vid=221020`. The [source manifest](./evidence/2026-10-08-accounting-discovery/sources.json)
records access evidence. Case conclusions here are taken from the official Danish guidance;
they are not represented as independent reviews of each entire court judgment.

| Ref | Exact source and sections | Supports |
| --- | --- | --- |
| R1 | [D.A.7.2.5, Regel; Specificeret; blandet sortiment](https://info.skat.dk/data.aspx?oid=2060295&vid=221020) | Specified-supply advance test, control of funds, contrary BUPA example and voucher boundary. |
| R2 | [D.A.7.2.7, Regel; C-463/14; C-324/20](https://info.skat.dk/data.aspx?oid=2060297&vid=221020) | Availability can be consideration; one-time service installments are not automatically continuous services. |
| R3 | [D.A.8.1.1.1.4, contract changes and cancellation sections](https://info.skat.dk/data.aspx?oid=1978062&vid=221020) | Cancellation treatment depends on facts, with both taxable and non-taxable outcomes. |
| R4 | [A.B.3.3.1.2, invoice duty, early parts and credit notes](https://info.skat.dk/data.aspx?oid=2068787&vid=221020) | Tax-document boundary with #24 and subsequent corrections. |
| R5 | [Momsloven LBK 209/2024, §§23 and 52 a](https://www.retsinformation.dk/eli/lta/2024/209/pdf) | Original statutory wording read alongside current guidance, not a full amendment audit. |

| #59 requirement | Status |
| --- | --- |
| Distinct representative capacity, money and fixed-fee examples | Supplied as synthetic examples with buyer statements and balances. |
| Accountant review and Danish advance boundary | Boundary supplied; accountant review **unmet**. |
| Explicit carryover, overage and refundable-balance decisions | Supplied for a conditional first scope. No term is approved for launch. |
| Follow-up with validated job, supported terms and pilot outcome | Protocol, gates and proposed metrics supplied. Customer validation and actual outcomes **unmet**; implementation deferred. |
