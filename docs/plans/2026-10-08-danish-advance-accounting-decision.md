# Danish advance payments, documents and accounting

Decision record for [#24](https://github.com/tielemans-dev/quits-oss/issues/24), 8 October 2026.
Status: proposed, pending parent and qualified Danish accountant review. No accountant has
reviewed this record. No customer books, credentials or provider accounts were accessed.
The examples are synthetic. They establish arithmetic, not approved accounting policy.

## Decision and boundary

Keep prepayment issuance blocked. The first candidate for a separately approved implementation
is one identified Danish B2B service, DKK, Danish VAT at 25%, one accepted contract, a stated
advance and a final reconciliation. Support the same accounting facts for card and bank payments.
Use the existing money foundation for receipts and evidence. Do not turn a schedule line into
extra sales revenue or create a second spendable balance.

The proposed normal route is an **advance invoice for a specified part of the price**, followed
by receipt, delivery and a final invoice for the amount not already invoiced. Danish guidance
requires a separate invoice when part of the supply is demanded before completion [A1, A4].
A document called a request or pro forma does not establish an exemption from that duty. A
non-binding estimate may show proposed terms but cannot be the default collection document.
The accountant must approve the precise document and timing before this route is implemented.

An unexpected qualifying receipt before invoicing has a different tax trigger. VAT can become
due on receipt even without an invoice [A2, A3]. Delaying invoice creation does not defer that
VAT. The eventual tax invoice must document the same assessment, never charge it again.

Defer foreign currency, mixed tax treatments, unallocated wallets, voucher-like credit,
forfeiture, transfers between contracts, construction-specific arrangements and cross-border
advances. The examples below exercise their accounting questions without enabling them.
Reserved capacity and recurring fixed fees belong to the separate #59 decision. Custody,
trust accounts, tax filing and a Quits general ledger remain outside scope.

## Evidence and present runtime

Audited source and initial base: `c0f23c014d0502c44fab9b7ea8b7a748c6b5eee8`.
Source links below are pinned to that commit. This record changes only documentation and fixtures.

| Evidence inspected | What exists at this base |
| --- | --- |
| [Invoice commands](https://github.com/tielemans-dev/quits-oss/blob/c0f23c014d0502c44fab9b7ea8b7a748c6b5eee8/apps/oss/src/domain/commands/invoices.ts), `invoiceEmailApprovalContext`, `sendInvoice` | Approval and sending reject `prepayment` with `purpose_issuance_not_supported`. Preserve both guards. |
| [Agreement invoice commands](https://github.com/tielemans-dev/quits-oss/blob/c0f23c014d0502c44fab9b7ea8b7a748c6b5eee8/apps/oss/src/domain/commands/invoices-from-deliverables.ts) | Schedule lines can make prepayment drafts. `scheduleSaleChoice` records an explicit sale choice, not an advance application. |
| [Payment commands](https://github.com/tielemans-dev/quits-oss/blob/c0f23c014d0502c44fab9b7ea8b7a748c6b5eee8/apps/oss/src/domain/commands/payments.ts), `applyPayment` | Payments are invoice-bound. Manual overpayment is rejected; evidenced Stripe overpayment is recorded. Neither establishes a reusable advance. |
| [Posting function](https://github.com/tielemans-dev/quits-oss/blob/c0f23c014d0502c44fab9b7ea8b7a748c6b5eee8/apps/oss/src/domain/accounting/postings.ts) and [money design](./2026-10-07-ledger-ready-money-model-design.md) | The existing posting policy does not implement this proposed advance lifecycle. Older Phase B/C plans are not runtime evidence. |
| [Accounting exports](https://github.com/tielemans-dev/quits-oss/blob/c0f23c014d0502c44fab9b7ea8b7a748c6b5eee8/apps/oss/src/lib/exports/accounting.ts) | Invoice, credit-note and payment CSVs exist. CSV export is not evidence of an e-conomic posting or reviewed VAT treatment. |

Read-only integration inputs, not imported dependencies:

- Money draft #72 at `295d00bbb856ec79c536e33888569a29592d52dc`, especially
  `docs/architecture/settlement-receipts.md`. Receipts separate gross, net, evidenced fees,
  allocations and recorded external refunds. Classification as customer credit creates no funds.
  The draft does not infer carrying values, fee VAT or FX postings; its posting function refuses
  settlement events. Recording a refund does not send money.
- Schedule draft #71 at `9adf93f73147c9a78414fc561f05abe22bd30bcc`, especially
  `docs/plans/2026-10-08-canonical-payment-schedule-design.md`. It has one versioned owner,
  conserved advance quantities and a pure position prototype. VAT timing is explicitly open.
  Its full-sale-plus-advance example is an economic position, not an approved fiscal document.
  It also identifies v2 schedule-as-sale double-count exposure. This discovery does not repair it.
- Denmark draft #66 at `7f37ed6ed93ad0d072ada6911c2936fbbf67bd87`, both Denmark decisions.
  Original-artifact handoff, qualified classification review and the XML storage gap remain gates.
  The tested Peppol shapes do not prove support for advance reconciliation documents.

## Authoritative sources and limits

All sources in this table were accessed on **2026-10-08**. Skattestyrelsen pages are pinned to
Den juridiske vejledning **2026-2**, `vid=221020`. The source manifest in
[evidence](./evidence/2026-10-08-accounting-discovery/sources.json) records retrieval dates,
response hashes, sections and short excerpts. Statutes were also read from their original PDFs.
Those PDFs are the cited editions, not an independently consolidated audit of all amendments.
Current guidance supplies the contemporary interpretation; qualified review remains required.

| Ref | Exact source and section | Finding used here |
| --- | --- | --- |
| A1 | [Momsloven, LBK 209/2024, §§23, 27, 52 a](https://www.retsinformation.dk/eli/lta/2024/209/pdf) | Delivery, advance invoice and receipt tax points differ; an early demanded part requires a separate invoice; later price corrections use credit notes or supplementary invoices. |
| A2 | [D.A.7.2.5, Regel; Råderet; Specificeret på forudbetalingstidspunktet](https://info.skat.dk/data.aspx?oid=2060295&vid=221020) | Receipt tax requires control of funds and sufficiently specified supply/tax treatment. The guide expressly discusses a single rate and the BUPA mixed-assortment counterexample. |
| A3 | [D.A.8.1.1.13, Lovgrundlag and Regel](https://info.skat.dk/data.aspx?oid=1978058&vid=221020) | At 25% VAT, the net base is 80% of the gross qualifying advance; VAT is 20% of gross, not 25% of gross. |
| A4 | [A.B.3.3.1.2, Pligten; Faktureringstidspunkt; Kreditnotaer](https://info.skat.dk/data.aspx?oid=2068787&vid=221020) | An early demanded part needs its own invoice. Corrections reference the original date and number. |
| A5 | [D.A.7.2.4, Regel and Forudfaktureringer](https://info.skat.dk/data.aspx?oid=2060294&vid=221020) | Invoice timing can precede receipt. Artificial advance invoicing inconsistent with economic reality can be set aside; the current guide includes SKM2026.277.SR. |
| A6 | [A.B.3.3.1.4, Kravene til en faktura; Fakturering i euro/anden fremmed mønt](https://info.skat.dk/data.aspx?oid=2068789&vid=221020) | Number, date, parties, supply, taxable base, rate and VAT matter. Internally canceling an issued invoice is insufficient. EUR and other currencies have different display requirements. |
| A7 | [Momsbekendtgørelsen, BEK 1435/2023, §§58, 97](https://www.retsinformation.dk/eli/lta/2023/1435/pdf) | Invoice contents and FX conversion rules. §97(4) uses the published rate at the tax point, with stated alternatives and a documented method binding for at least two years. A processor payout rate is not automatically the VAT rate. |
| A8 | [D.A.8.1.1.1.4, Vederlag for efterfølgende ændringer; Erstatning for annullering før levering](https://info.skat.dk/data.aspx?oid=1978062&vid=221020) | Cancellation compensation is fact-dependent. The hotel deposit case C-277/05 is not a general exemption; the guide also treats C-622/23 payments for begun work as consideration. |
| A9 | [D.A.8.1.1.8, Hovedregel: Markedsprismetoden; Undtagelse](https://info.skat.dk/data.aspx?oid=1978053&vid=221020) | Allocation between taxable and exempt supplies needs a justified price basis. An arbitrary split on an invoice does not prove that basis. |
| A10 | [D.A.7.2.7, Regel and C-463/14](https://info.skat.dk/data.aspx?oid=2060297&vid=221020) | Continuous availability can be a service even when unused. Splitting a one-time service into payments does not make it a continuous supply. |
| A11 | [e-conomic REST docs](https://restdocs.e-conomic.com/?_escaped_fragment_=), Idempotency tokens; `POST /journals/:journalNumber/vouchers`; voucher attachments; Journals overview | Manual customer invoice, payment and finance voucher categories exist. Idempotency responses are cached for only one hour. No posting was attempted. |
| A12 | [Stripe SEPA Direct Debit](https://docs.stripe.com/payments/sepa-debit), Refunds and Disputes | Refund, dispute and original fee are separate facts; even a refund can coexist with a bank dispute. This is method-specific evidence, not a fee quote for the card examples. |

No interviews or accountant approvals were found in the assignment evidence. Competitor deposit
and retainer help pages supplied with the issue establish product terminology and reported needs;
they do not establish Danish treatment, demand among our customers, or production correctness.

## Separate facts and balances

| Term | Proposed meaning | Must not imply |
| --- | --- | --- |
| Proposed advance request | Non-binding terms before a payment demand; artifact has an explicit non-invoice role | That a binding advance demand escapes §52 a or VAT |
| Advance tax invoice | Numbered fiscal document for a specified early part of the price | Earned revenue merely because VAT is due |
| Gross receipt | Money paid by this customer in a stated currency | Net bank payout, revenue, or an allocation |
| Processor clearing | Gross claim on processor, later discharged by net payout and evidenced fees | The customer's debt is short by the fee |
| Advance entitlement | The customer's gross amount to apply to this contract or recover | A second receipt or general wallet |
| Net contract liability | Undelivered consideration after separating VAT already due | The customer's gross refund amount |
| Unallocated overpayment | Evidenced excess pending identification, repayment or separately approved classification | Revenue, a discount, or automatic advance VAT |
| Credit note | Correction to an issued fiscal document | Cash returned or permission to charge again |
| Refund | Actual external return of funds, with reference and status | A tax correction without its own evidence |

The economic position may say DKK 50,000 contract, DKK 15,000 advance applied, DKK 35,000 due.
The fiscal documents under the proposal invoice DKK 15,000 first and DKK 35,000 later. Posting a
new DKK 50,000 tax invoice and simply subtracting a DKK 15,000 payment would duplicate DKK 3,000
of VAT in this route. An alternative full-price fiscal document would need explicit coverage of
previously taxed amounts and an independently reviewed posting/export policy. It is not approved.

Preserve at least organization, customer, obligation and accepted revision, plan version, receipt
identity and currency, gross/net/fee evidence, tax-assessment identity, VAT groups, tax point,
document and original hashes, application/reversal references, refund provider identity/status,
base carrying values and rate evidence. Names are proposed facts, not new schema in this patch.
A state change cannot silently reassess a past receipt's tax treatment.

## Event, accounting, document and e-conomic mapping

Entries below are proposed account roles, not prescribed account numbers. `AR` is the customer's
receivable control, `AL` the net advance liability, `VAT` output VAT, `REV` earned sales revenue,
`CLR` processor clearing and `BANK` bank. Debit and credit amounts are positive. A posting adapter
must obtain the accountant's account/VAT-code mapping and period policy before writing.

| Event | Customer position and illustrative entry | Document/tax timing | e-conomic handoff proposal |
| --- | --- | --- | --- |
| Terms proposed | No receipt, invoice debt or earned revenue | Quote/contract terms only; request role needs review before a demand | No financial voucher |
| Advance demanded and invoiced | For gross 15,000: Dr AR 15,000; Cr AL 12,000; Cr VAT 3,000. Advance funds still zero until receipt | Issue immutable advance invoice; VAT at qualifying invoice tax point [A1, A4, A5] | Manual customer invoice voucher, liability account and VAT code, original PDF; avoid default sales-revenue posting |
| Bank receipt against that invoice | Dr BANK 15,000; Cr AR 15,000. Available contract entitlement 15,000 | Receipt links invoice; no second VAT event | Customer payment against original advance receivable; bank reference |
| Card receipt and payout | Dr CLR 15,000; Cr AR 15,000. Then Dr BANK 14,775 and fee expense 225; Cr CLR 15,000 | Capture/control date, settlement date and payout date separate; authorization alone is not receipt | Customer payment to clearing; payout/fee finance voucher with fee evidence, unknown tax treatment refused |
| Unexpected qualifying receipt first | Dr BANK 15,000; Cr AL 12,000; Cr VAT 3,000 once assessment is established. Unidentified receipts initially stay in a suspense liability | Receipt tax point [A2, A3]; issue required document without another receivable/revenue/tax posting for the same assessment | Receipt-first mapping and zero-duplicate tax documentation must be demonstrated in sandbox; blocked meanwhile |
| Delivery and final reconciliation | New invoice: Dr AR 35,000; Cr REV 28,000; Cr VAT 7,000. Release liability: Dr AL 12,000; Cr REV 12,000. Consume entitlement 15,000 | Show total work 40,000 + VAT 10,000, minus already invoiced 12,000 + VAT 3,000, new invoice 35,000; reference advance invoice | Manual customer invoice for residual plus separate linked finance voucher for AL release; one source event per posting |
| Final bank payment | Dr BANK 35,000; Cr AR 35,000 | Receipt only | Customer payment against final invoice |
| Advance correction before supply | For gross refund 5,000: Dr AL 4,000; Dr VAT 1,000; Cr customer refund payable 5,000 | Credit original advance invoice. Exact VAT reduction period/evidence needs approval; fixture assumes correction and actual refund in same open period | Credit/reversal mapped to original advance document; do not credit revenue never earned |
| Actual refund | Dr refund payable 5,000; Cr BANK/CLR 5,000. Consume entitlement 5,000 | External successful refund reference; pending/failed is not cash returned | Customer refund/finance voucher per reviewed debtor mapping; preserve refund reference |
| Accidental excess | Dr BANK 1,000; Cr unallocated customer liability 1,000. Return or review | Not automatically VAT/revenue. If facts make it additional consideration, assess separately | Suspense/customer liability, then separately evidenced disposition |
| Provider return/chargeback | Restore actual receivable or customer-funds position, record fees separately | Does not itself cancel the supply or reverse VAT | Corrective payment voucher; accountant decides subsequent credit/bad-debt treatment |

Customer refund payable may use a credit debtor balance in the reviewed chart. Keep it separately
named here so money owed to the customer cannot disappear inside a clamped zero balance.
If refund is delayed, this is a payable until cash is actually returned. Whether VAT can be reduced
before repayment is not decided here. A2's FIRIN discussion is contrary evidence to a blanket
"credit note always immediately recovers VAT" rule.

### Handoff mechanics and existing draft incompatibilities

Use the e-conomic journal route as a candidate, since Quits owns the issued document and number.
`manualCustomerInvoices`, `customerPayments` and `financeVouchers` in the voucher schema are
categories to validate using the provider's templates. Do not copy the documentation's example
payload as an approved mapping. Debit/credit signs, VAT-code behavior, liability-account allowance,
customer matching, journal booking and the resulting ledger must be proven with an accountant
and a sandbox. Creating a journal draft is not booking it.

Persist a handoff identity per event/version and destination agreement, payload hash, accounting
year/journal/voucher IDs and attachment hash. e-conomic documents an **hour-long** idempotency
cache [A11]. Keep durable deduplication locally; reconcile unknown outcomes before retrying,
including after that hour. Do not rotate keys merely because a response was lost. Reconcile
voucher lines, booked status, VAT, debtor balance and original attachment after posting. The
Denmark draft's PDF/XML-original gap still applies to advance documents. No API write occurred.

The accepted money draft counts a receipt allocation as consuming that receipt. Paying an
advance tax invoice and then allocating the same receipt to the final invoice would consume it
twice. The future adapter needs one funding identity, an advance-purpose tax document and an
application of the resulting entitlement. The entitlement release moves liability to revenue;
it does not mint cash or a second general credit. This distinction is an integration gate with
#72, not permission to add a competing ledger. Existing allocation records cannot be reinterpreted.

The schedule prototype's `advance_then_billing` sale step represents the full obligation. The
fiscal residual invoice in this proposal has a different payable amount. A future joint change
must distinguish covered supply from newly invoiced/collectible amount, keep one plan owner and
prove both reconciliations. Do not wire its current full-sale snapshot into this posting table.
No automatic conversion of `scheduleSaleChoice` invoices is safe; inspect and correct each with
its original documents. Preserve current numbering-at-issuance, payment-detail snapshots and
PDF VAT/price-basis behavior. UX owns all document-view, invoice/quote command/editor and render
changes. This discovery does not alter those files or remove any guards.

## Worked reconciliations

All examples below assume agreed tax treatment, timely documents, open periods, no bad debt and
no cancellation charge. These are assumptions for review. DKK amounts have two decimals. The
card fee is a synthetic DKK 225.00 expense with **no input VAT claimed**, not a provider price or
an assertion that every processing fee is exempt. An unknown fee stays unknown in the product.

### Same 30% advance by bank and card

Contract: specified service DKK 40,000.00 net + 10,000.00 VAT = 50,000.00 gross.
Advance invoice on 1 October: 12,000.00 net + 3,000.00 VAT = 15,000.00.
Payment on 8 October. Delivery and final invoice on 31 October: 28,000.00 net + 7,000.00 VAT =
35,000.00, plus release of the 12,000.00 net advance liability into revenue.

| Position after each step | Bank route | Card route |
| --- | --- | --- |
| Advance invoice | AR 15,000; AL 12,000; VAT 3,000; revenue 0 | Same |
| Advance receipt/payout | Bank 15,000; AR 0; entitlement 15,000 | Clearing receives 15,000, then bank 14,775 + expense 225; AR 0; entitlement 15,000 |
| Final invoice and application | AR 35,000; AL 0; cumulative revenue 40,000; VAT 10,000; entitlement 0 | Same |
| Final bank receipt | Bank 50,000; AR 0 | Bank 49,775; fee expense 225; AR 0 |

Both routes discharge exactly 50,000 of customer debt. Card payout plus fee equals gross receipts.
Revenue is 40,000 once; VAT is 3,000 + 7,000 = 10,000 once. No application creates a cash receipt.

### Corrections and remaining credit

Each row starts with the same 15,000 paid advance unless stated otherwise. The fixture bundle
contains complete balanced entries and receipt snapshots for each row.

| Scenario | Documents and application | Reconciled result |
| --- | --- | --- |
| Cancel all work, refund all | Credit advance 12,000 net/3,000 VAT; refund 15,000 | Receipts 15,000 = refunds 15,000. Revenue/VAT/AL/AR all zero. Card variant retains expense 225 and bank balance -225, funded by seller, never deducted silently from refund. |
| Cancel after 10,000 gross of evidenced work | Credit unused advance 4,000 net/1,000 VAT and refund 5,000; release retained AL 8,000 for actual delivered work | Receipts 15,000 = applied 10,000 + refunded 5,000. Revenue 8,000; VAT 2,000; bank 10,000; no remaining debt. The retained amount is earned work, not assumed cancellation compensation. |
| Partial refund 5,000, same 50,000 contract | Credit advance 4,000/1,000 and refund 5,000; apply remaining 10,000; final invoice 32,000/8,000 = 40,000 | Advance 15,000 = refund 5,000 + applied 10,000. Cash 15,000 - 5,000 + 40,000 = 50,000; revenue 40,000, VAT 10,000. |
| Accidental 1,000 excess bank transfer | Receive 16,000, of which only 15,000 settles the advance invoice. Hold 1,000 separately and return it. Final invoice/receipt 35,000 | Cash 16,000 - 1,000 + 35,000 = 50,000. Excess never becomes revenue or inferred advance VAT. |
| Insufficient remaining advance | Refund 5,000 first, leaving 10,000. Attempt to apply 15,000 must fail without any entries. Apply 10,000 to the 50,000 delivery; leave final 40,000 unpaid | Advance availability 0; AL 0; AR 40,000; cash 10,000; revenue 40,000; VAT 10,000. A payment shortfall is not a fee or writeoff. |
| Final contract increased to 62,500 | Obtain new accepted revision before delivery. Apply 15,000; final invoice 38,000/9,500 = 47,500 | Revenue 50,000; VAT 12,500; cash 62,500 after final payment. Never rewrite the original advance. |
| Final contract reduced to 12,500 | Accept scope reduction; credit excess advance 2,000/500 = 2,500 and refund it. Apply retained 12,500 | Release AL 10,000; revenue 10,000; VAT 2,500; cash 12,500. Newly invoiced final amount is zero; final statement/document treatment requires review. Never issue a negative invoice for the excess. |

A cancellation with retained compensation is deliberately **not** modeled as the no-fee refund.
A8 includes taxable and non-taxable outcomes depending on what the payment buys and whether
performance began. Require the actual contract and accountant conclusion, including any VAT
reassessment and separate compensation document. Do not infer treatment from "non-refundable".

### Mixed VAT and rounding, review only

Assume two separately identified, independently priced supplies: taxable net 8,000 + VAT 2,000,
and exempt 2,000 with an evidenced exemption. Contract gross 12,000. A 30% amount is 3,600,
composed of taxable gross 3,000 = net 2,400 + VAT 600 and exempt 600. Final residual gross 8,400
contains taxable net 5,600 + VAT 1,400 and exempt 1,400. Revenue totals 10,000 and VAT 2,000.

This arithmetic is valid only under the stated allocation; it does not prove that a single
mixed advance is legally taxable at receipt. A2 explicitly requires specified supply and discusses
a single rate. A9 requires a supported price allocation. An open-ended credit usable for either
service is outside the proposed first scope; voucher rules may instead apply. Never substitute
"0%" for a classified exemption. Cross-border rates and later tax-treatment changes stay blocked.

Resolve percentages once in minor units using cumulative half-up rounding, with the last share
absorbing the residual. Example: gross 100.01 at 25%, frozen net 80.01/tax 20.00. Thirty percent
is 30.00, tax 6.00/net 24.00; remaining 70.01 is net 56.01/tax 14.00. Refund/application components
use the original frozen group and cumulative entitlement. For a 0.03 gross lot with 0.01 tax,
three 0.01 slices carry tax 0.00, 0.01, 0.00. Independently rounding each slice would lose the cent.
These are calculation proposals aligned with #71/#72, not a new tax classification algorithm.

### EUR receipt and DKK books, review only

Specified Danish taxable service: EUR 1,000 + VAT 250 = 1,250. Advance EUR 375 = net 300/VAT 75.
Synthetic rates are DKK per EUR; they are invented for arithmetic, not retrieved market rates.
Assume a reviewer accepts historical measurement for this non-monetary performance liability
and the stated rates as the tax-point rates. Refundable monetary liabilities may need a different
policy; this fixture does not decide that question.

| Fact | EUR | DKK accounting |
| --- | --- | --- |
| Advance invoice and receipt, 7.45 | 375 gross, 300 net, 75 VAT | Gross 2,793.75; AL 2,235.00; VAT 558.75 |
| Processor fee and converted payout, 7.45 | 5 fee, 370 net | Expense 37.25; bank 2,756.50; clearing zero |
| Final residual invoice, 7.50 | 875 gross, 700 net, 175 VAT | AR 6,562.50; new revenue 5,250.00; new VAT 1,312.50 |
| Advance applied | 375 entitlement | Release historical AL 2,235.00 to revenue, no new VAT |
| Final payment, 7.46 | 875 | Bank 6,527.50; realized AR loss 35.00; AR zero |

Cumulative revenue 7,485.00 + VAT 1,871.25 = bank 9,284.00 + fee 37.25 + FX loss 35.00.
EUR advance 375 is applied once; total receipts 1,250 EUR, no exchange-rate-created EUR credit.
Do not translate the full final supply at 7.50 and silently overwrite the historical advance VAT.
Do not use the payout rate as the VAT rate unless it independently meets the reviewed policy.
A7's rate method, non-EUR invoice display, monetary/non-monetary classification, revaluation,
partial carrying-value discharge and refund FX must be approved before FX implementation.

## Validation and review protocol

Run `python3 docs/plans/evidence/2026-10-08-accounting-discovery/validate.py` for exact integer
conservation, per-event double-entry balance, fiscal tax totals, final account balances and the
explicit insufficient-credit negative case. This pure fixture probe imports no product modules
and writes no data. It is not a runtime test, provider exchange or accountant signoff.

A Danish VAT-experienced accountant/bookkeeper must review the original contract, each event,
tax date, account role, document, VAT return period and proposed e-conomic row. A maintainer
then reviews integration and the UX owner reviews the document handoff. Record reviewer name,
qualification, review date, exact source/fixture SHA, accepted scope, exceptions and unresolved
objections. Obtain corrections in writing; do not treat a meeting invitation as approval.

Review packet and unanswered questions:

1. Confirm the advance invoice duty, exact trigger and document for demanded and unexpected
   receipts; determine card receipt/control timing including processor reserves.
2. Approve the final residual document and e-conomic mapping, including zero final amount and
   advance invoice AR versus the customer's advance entitlement.
3. Approve cancellation/partial refund tax timing, including delayed or failed refunds, retained
   fees and compensation. Confirm what must happen in closed periods.
4. Reject or approve each mixed-treatment example using real supply/exemption evidence and a
   defensible allocation. Decide if any monetary-credit arrangement is a voucher.
5. Approve fee VAT evidence, FX rate policy, liability classification and carrying-value discharge.
6. Demonstrate voucher posting, booking, matching and original read-back with authorized sandbox
   data, including a response lost beyond the one-hour idempotency cache. No access exists here.

Kvit UI handoff, for UX only: show contract total, already invoiced advance, money actually
received, net payout/fee, available entitlement, previously assessed VAT and newly due amount
as distinct quantities. Preserve original and corrective documents with dates and reasons.
Before application/refund show the exact affected lot, tax groups, remaining amount and failures.
A pending refund must read pending; an unclassified receipt must not look spendable. Copy must
state that requesting, invoicing, paying, delivering and refunding are separate actions. No new
screen, branding or document renderer is part of this work.

## Acceptance status

| #24 requirement | Status |
| --- | --- |
| Reviewed event/customer-balance/tax/document/e-conomic decision | Mapping supplied; parent and qualified accountant review **unmet**. Provider mapping unproven. |
| 30% card and bank reconcile without duplicate revenue/VAT | Synthetic examples and executable arithmetic supplied; production behavior not implemented. |
| Cancellation, partial refund, excess, insufficient credit, changed contract | Supplied with assumptions, conserved fixtures and blocked unsupported treatments. |
| Authoritative Danish sources, reviewer role and open questions | Supplied, including contrary guidance and exact source dates. |
| Keep implementation gated and prepayment block intact | Met by docs-only scope; no product/schema changes. |

No launch approval follows from this record. A future implementation brief may cover only the
reviewed DKK arrangement after #72 and the schedule/document integration decisions are accepted.
