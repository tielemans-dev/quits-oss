# Posting roles in Phase A

`apps/oss/src/domain/accounting/postings.ts` exports the pure, internal function
`postingsFor(event): Posting[] | PostingRefusal`. It consumes an envelope with `type`,
`schemaVersion` and `payload`. It has no Prisma, runtime service, clock or database dependency.
A4 adds no published package export, chart of accounts, ledger storage or UI.

Posting amounts are decimal strings of integer base minor units. `debitMinor` and `creditMinor`
are nonnegative; the base `currency` and `exponent` accompany every line. `vatGroup` is the
frozen key of treatment, reason, rate and country, or null for the document's debtor line.
Zero-tax treatments keep their group through a revenue line, including a zero revenue line,
but have no output VAT line. Zero rounding lines also retain the group's components.
The test-only in-memory ledger uses positive debit balances and negative credit balances.

## Roles

| Role | Why it exists |
| --- | --- |
| `debtor` | The customer's receivable at its frozen base carrying value. |
| `revenue` | Supply consideration, separately for each VAT group. |
| `output_vat` | VAT due on the supply, separately for each VAT group. |
| `payable_rounding` | The signed difference between payable gross and independently rounded net and tax. |
| `fx_gain` | Reserved for a future gain when valuation differs from a discharged position's carrying value. |
| `fx_loss` | Reserved for the corresponding future loss. |
| `customer_credit` | Reserved for customer credit created beyond receivable discharge. |

Phase A emits no FX or customer-credit lines. Those policies need position events in later phases.

## Phase A table

| Event | Posting |
| --- | --- |
| `invoice.issued` v1, sale | Debit debtor at gross base. Credit revenue at net base and output VAT at tax base per group. Credit payable rounding for positive rounding, debit it for negative rounding. |
| `credit_note.issued` v2, postable sale correction | Debit each historical revenue, VAT and rounding component per group when positive, credit it when negative. Credit debtor at `debtorDischarge.carryingBase`. No FX line. |

Every component is signed. An intended debit of a negative amount becomes a credit of its
absolute value; an intended credit of a negative amount becomes a debit. No signed component
is clamped or discarded. In particular, the third one-cent credit on a EUR five-cent invoice
at rate 0.8 has negative base net: credit revenue one base cent and debit VAT one base cent.
Its debtor discharge is zero and the credit still balances.

## Refusals

The result is either an array of lines or `{ code, detail }`. Refused events produce no lines.
The named cases all have fixtures in `domain/accounting/__tests__/fixtures.ts` and pure tests.

| Code | Cases |
| --- | --- |
| `base_valuation_unknown` | Missing or unknown valuation; unknown frozen base components or debtor carrying value. |
| `not_postable` | Sparse v1 credit, unsupported version or currency, invalid/incomplete payload, `postable: false`, or any `incompleteReason`. |
| `tax_point_review_required` | Earlier or null invoice supply date, inherited review, `assessment_required`, `none`, or an `invoice_issued` tax point date different from issue date. |
| `unsupported_treatment_combination` | Mixed out-of-scope; unclassified zero, zero-rated or domestic reverse charge; standard at rate zero; nonstandard at nonzero rate; missing or invalid evidence, identifiers or statement; invalid/unavailable VIES; export without reference or outside-EU buyer country; exemption without reason text. |
| `purpose_not_supported` | Prepayment invoice or a credit correcting a purpose other than sale. |
| `advances_not_supported` | Covered advance or `advance_received` tax point. |
| `applications_not_supported` | Deposit application, allocation release or customer-credit creation. |
| `equation_violation` | Either frozen document equation fails, inconsistent component/line totals, sub-minor precision, reversal/discharge mismatch or nonzero Phase A FX difference. |
| `event_not_supported` | All other events, including every Phase B and C event. |

Incomplete credits return `not_postable` with their original `incompleteReason` in `detail`,
including `allocations_pending`, `purpose_not_supported` and `balance_adjustment_unsupported`.
This takes precedence over interpreting a credit whose completion facts are absent.
Unknown invoice valuation takes precedence over its other policy facts. A supported sale's
purpose, advance/application and tax-point guards precede the evidence and equation checks.
Malformed payloads refuse rather than manufacture accounting facts.

## Dates and carrying values

`occurredAt` records when the economic fact occurred. `postingDate` tells a consumer when to
book it and may differ when a period is closed. `taxPointDate` determines the VAT tax point.
For Phase A's `invoice_issued` reason, the tax point must equal `issueDate`.
There is no tax-point window. Any invoice supply date before issue date, even by one day,
requires review, as does a null legacy supply date. A sale issued at or before supply can post.
Credits inherit the original tax-point reason; their tax point uses the credit's issue date.
Their original supply date is therefore not compared to their later credit issue date.
Verify the legal tax-point and treatment policies with an accountant.

Every position must have a carrying value; discharge consumes its current carrying value.
The general rule is remaining carrying value multiplied by discharged quantity divided by
remaining quantity, with the final discharge taking the residual. Restoring an exhausted
position creates a new position at the restoration valuation. Phase A has no positions yet.
It only accepts credit events with frozen-component discharge, no payments/applications,
no customer-credit creation and zero FX difference. It checks discharge quantity against
credited gross and carrying base against the signed historical components.

## Rounding, equations and precision

The shared pricing calculator owns arithmetic. Inclusive prices allocate line net and tax
independently; an individual line's net plus tax need not equal its gross. The posting function
reads the frozen amounts and checks group allocation totals; it never recalculates prices.

The document equation is `net + tax + payableRounding - depositApplicationsGross = payableGross`.
Phase A refuses applications, so `net + tax + payableRounding = gross`. In base currency,
`netBase + taxBase + payableRoundingBase = debtorBase`. Both hold per VAT group and in total.
Base gross, VAT and rounding are rounded independently; base net is the difference.
Credits use differences of cumulative entitlements from the frozen original components.
The final credit absorbs the remaining components, including rounding. Each constructed
posting array asserts that total debit minor units equal total credit minor units.

Money supports exponents 0, 1 and 2 by contract; three-decimal currencies refuse. The current
shared currency catalogue contains only supported exponents 0 and 2, so no exponent-1 currency
can yet be emitted. Quantity input supports six decimals and unit price input four,
independently of money precision. Decimal strings are used throughout; posting arithmetic
uses exact integer minor units, including amounts beyond JavaScript's safe integer range.

`vatReporting` records a separate VAT-return rate and amounts. It is reporting-only and never
supplies posting amounts. Adding, changing or removing it leaves the posting array unchanged.
Credit-side VAT-return allocation remains an A3b open issue.

The sync worker and the ledger module both consume `postingsFor`; neither reads document rows.
