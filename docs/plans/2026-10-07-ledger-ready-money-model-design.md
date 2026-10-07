# Ledger-Ready Money Model Design

Status: revision 8, after adversarial review rounds 1 to 6 and the code-fit round-5 amendment (accounting lens and code-fit lens),
2026-10-07. Built on four read-only code audits of commit 267dc06.

**Scope of this revision.** Phase A (the invoice side, PRs A1 to A4, plus the cloud gates) is a
contract ready for briefs. Phases B and C (payments, Stripe, write-off, deposits, periods,
retention) are **draft**: their data-model additions are stable enough to design around, but their
posting policies have open accounting contradictions that need a bookkeeper's answer, not another
model round. Each open point is listed in "Known open issues" so nothing is lost. The posting
function in A4 refuses every event whose policy is still open.

## Summary

Quits will feed bookkeeping in two ways: now, by syncing issued invoices, credit notes and
payments to the user's bookkeeping system as vouchers; later, through an optional Danish
double-entry ledger module. Both are consumers of the domain event log. This design makes every
money event carry what a balanced posting needs, makes the event log usable as an outbox, and adds
a pure posting function that proves the data is sufficient. It builds **no ledger, no chart of
accounts and no bookkeeping UI**.

The product line becomes: agreement, work, money, and the books that follow from them.

## Principles

1. **Issued documents never change.** Additions land in new, versioned snapshots and events, each
   with a stated fallback for older documents.
2. **Money is integer minor units** with the currency exponent beside it. Supported exponents 0,
   1 and 2.
3. **Abstract account roles, not account numbers.**
4. **Separate facts stay separate.** Issuance, email delivery, work accepted, money received,
   identified, allocated, VAT becoming due: each its own event with its own date.
5. **Unknown stays unknown.** Unreported fee: null. Old valuation: `unknown`. Unclassified zero-rate
   line: `unclassified_zero`. Unassessed fee tax: refused.
6. **Vouchers are files**, stored with a hash before anything is sent.
7. **Every position has a carrying value and every discharge uses the current one**
   (`remainingCarrying × dischargedQuantity / remainingQuantity`, final discharge absorbs the
   residual). Restoring an exhausted position is a new position valued at the restoring event's
   valuation. The posting function never needs state.
8. **Every legal rule is marked** "verify with an accountant" and the facts for either outcome are
   recorded.
9. **Refuse rather than guess.** Where a policy is open, the posting function returns a typed
   refusal and the UI says so.

## Non-goals

Accounting integrations, bank feeds, expenses, VAT returns, any ledger UI, chart of accounts,
period-end procedures and the revaluation procedure, three-decimal currencies, delivery-before-late-
invoice accrual (see tax points), registration with Erhvervsstyrelsen.

## Dates and valuation on every money event

| Field | Meaning |
| --- | --- |
| `occurredAt` | When the economic fact happened. Never changed. |
| `postingDate` | The date a consumer books it. Equals `occurredAt` unless the period is closed. |
| `taxPointDate`, `taxPointReason` | `invoice_issued` (momsloven § 23 stk. 2), `advance_received` (§ 23 stk. 3), `none`, `assessment_required`, `tax_point_review`. |
| `Valuation` | `{ base: Money, rate, rateScale, rateDate, rateSource }`, `rateSource` in `same_currency`, `user`, `provider:<name>`, `unknown`. The only rate that produces posting lines. |
| `vatReporting?` | `{ rate, rateSource, taxBaseForReturn, taxForReturn }`. Reporting-only; never a posting line. Verify with an accountant which rule applies (bekendtgørelse 2023/1435). |

**Tax-point derivation, Phase A scope.** `supplyDate` is required on every v2 invoice; the
editor defaults it to the issue date and the user confirms it. A `sale` invoice gets
`invoice_issued` only when `supplyDate >= issueDate` (invoice issued at or before delivery, § 23
stk. 2). Any earlier `supplyDate` gets `tax_point_review` and the posting function refuses with
`tax_point_review_required`; there is no window, because no safe-harbour number has been
approved by an accountant (verify, then a later revision may add one). A null `supplyDate` on a
legacy document is also `tax_point_review`. `taxPointDate` must equal `issueDate` for
`invoice_issued`; a mismatch is refused. Credit notes inherit the invoice's tax-point reason and
are refused when the invoice was under review. Advances (`advance_received`) are Phase C.

## Part 1: event envelope (PR A1, in implementation)

`DomainEvent.schemaVersion`; registry with zod schemas built from an inventory of today's
serialized shapes and fixtures; `appendEvents` validates and refuses unregistered types; test-only
registration; `upcastEvent` pure and total; both readers return `schemaVersion`; sparse v1 events
are `postable: false`.

## Part 2: Phase A events

Shared fragments: `Money { minor, currency, exponent }`, `Valuation`, `VatGroup { treatment,
rate, country, reasonCode?, net, tax, gross, netBase, taxBase, grossBase, evidence? }`, `Dates`.

### `document.artifact_stored` v1 (A3a)

Emitted at publication of an issuance candidate for invoices, credit notes and agreements:
`documentKind`, `documentId`, `candidateId`, `artifacts { pdf { ref, hash, size }, ubl? }`,
`rendererVersion`. When no renderer is configured (A3a release), `document.artifact_missing` v1
is emitted instead. A3a emits **no** `invoice.issued`; existing lifecycle events continue
unchanged until A3b.

### `invoice.issued` v1 (A3b)

Once per invoice, in the issuance transaction of every path. Payload: `documentId`, `number`,
`purpose: sale` (Phase A; `prepayment` is Phase C and refused by A4), `Dates`, `supplyDate`,
`dueDate`, `currency`, `exponent`, `Valuation`, `vatReporting?`, `lines[]` (lineId, description,
`quantityInput` and `unitPriceInput` as decimal strings, `net`, `tax`, `gross`, `vat`,
`deliverableId?`), `vatGroups[]` with `evidence`, `totals { net, tax, gross, payableRounding,
base equivalents }`, `calculation { version, roundingMode, pricesIncludeTax, exponent }`,
`seller`, `buyer` with tax ids refreshed at issuance, `coveredByAdvances: []` and
`depositApplications: []` (reserved, always empty in Phase A), `artifacts`, provenance ids.

### `credit_note.issued` v2 (A3b)

The credited portion. Payload: invoice-shaped lines and groups for the credited portion;
`correctsInvoiceId`, `correctsNumber`, `correctsPurpose`, `mode: lines | amount`, `reason`;
`creditedGroups[]` (per original group: creditable before, credited now, residual cents carried);
`historicalReversal { revenueBase, taxBase, roundingBase }` per group from the invoice's issuance
valuation, proportional; `debtorDischarge { quantity, carryingBase, valuationSource }`;
`customerCreditCreated { quantity, valuation } | null`; `allocationsReleased: [] | null`;
`fxDifferenceBase`; `postable`, `incompleteReason?`.

**Transition rule (A3b to B1).** Positions do not exist yet. A credit note is `postable` only when
all of: `correctsPurpose = sale`; the invoice has no non-voided payment; `coveredByAdvances` and
`depositApplications` on the invoice are empty; `allocationsReleased` is empty;
`customerCreditCreated` is null; the credited gross does not exceed the invoice's open balance
**after prior credits**; and `debtorDischarge.quantity` equals the credited gross with
`carryingBase` taken from the frozen base components per rule 8 (`valuationSource:
frozen_components`), so `fxDifferenceBase` is zero by construction in Phase A. Any other case is
`postable: false` with `incompleteReason` in `allocations_pending`, `purpose_not_supported`,
`balance_adjustment_unsupported`; B1 emits `credit_note.allocations_reconciled` v1 to complete the
first. `amount` mode input is gross, allocated across remaining creditable groups by remaining
gross, largest remainder, then rule 8 per group. A full cancellation takes every group's remaining
components, so the original rounding is reversed exactly.

## Part 3: VAT treatment, rounding and precision (A2a, A2b)

### Treatments

| Treatment | `reasonCode` | Required, validated at issuance and frozen in `VatGroup.evidence` | Peppol | Phase A |
| --- | --- | --- | --- | --- |
| `standard` | none | rate > 0 | S | postable |
| `intra_community` | `goods` | seller VAT id, `buyerVatId`, `viesCheck { at, result: valid }`, statement text | K | postable |
| `intra_community` | `services_b2b` | seller VAT id, `buyerVatId`, `viesCheck { at, result: valid }`, reverse-charge statement text (BR-AE-02 needs both ids) | AE | postable |
| `export` | `goods_outside_eu` | `exportEvidence { kind: customs_declaration \| carrier_document \| other, ref }`, buyer country outside EU | G | postable |
| `exempt` | `financial`, `health`, `education`, `other` | reason text; rate 0 | E | postable |
| `reverse_charge_domestic` | `construction`, `other` | statement text, buyer VAT id | AE | **refused** in Phase A (DK eligibility needs a specialist) |
| `out_of_scope` | none | no rate; cannot mix with other treatments on one document (BR-O-11, BR-O-05) | O | postable |
| `zero_rated` | none | kept in the vocabulary for non-DK sellers | Z | **refused** in Phase A |
| `unclassified_zero` | none | legacy only | refused | refused |

Every treatment other than `standard` requires `rate = 0` and therefore `tax = 0` on its group;
`standard` requires `rate > 0`. A VIES result other than `valid`, a missing identifier, a missing
statement, an evidence kind of `other` without a reference, or a rate that violates the row's rule
is `evidence_incomplete` and the issuance command refuses; the posting function refuses the same
with `unsupported_treatment_combination`. Verify with an
accountant: the eligibility conditions behind each row; the design records the evidence either
way. Columns on `InvoiceItem`, `QuoteItem`, `CreditNoteItem`, `Deliverable`: `vatTreatment`,
`vatCountry`, `vatReasonCode`; evidence lives on the document (`vatEvidence` JSON) and is copied
into the frozen groups. Legacy rows: `standard` where rate > 0, else `unclassified_zero`.

**Group key.** A VAT group is keyed by `(treatment, reasonCode, rate, country)`, which maps to
exactly one Peppol category; intra-community goods and services never share a group.

### Calculation version and the rule

`calculationVersion` document column: `legacy_per_line` for existing documents, `v2` for new.
Propagation: quote conversion copies version and amounts; recurring generation uses the current
version; deliverable invoicing uses the agreement's frozen version; credit notes carry the original
invoice's version and consume its frozen groups; drafts reprice on the current version; issued
documents keep theirs.

**Inputs.** The calculator takes decimal strings. Quantity and unit-price **input precision is
independent of the currency exponent**: inputs are bounded only by the schema (up to 6 decimals
for quantity, up to 4 for unit price), and money is rounded at the currency exponent only when
computed, so a quantity of 0.5 at 100 JPY yields 50, never 100. New contracts (agent tools, v2
editor routes) require strings. The existing numeric tRPC inputs stay accepted for the UI's
transition only: numbers are converted with `String(number)` (full JavaScript precision, never
`toFixed`) and flagged `inputPrecision: "number"`; that path is removed when every editor sends
strings. Legacy items get `quantityInput` and `unitPriceInput` backfilled from their Decimal
columns, flagged `inputPrecision: "backfilled"`. New editors keep string state and send strings. Items persist `quantityInput` and
`unitPriceInput` as strings beside the Decimal columns. Preview and server use the same module
(`@quits/shared/pricing`, `decimal.js-light`, exported and in the `files` list, verified from the
packed artifact; Prisma's Decimal is never imported in React). Editors covered: invoice new and
edit, quote new and edit, recurring dialog, agreement editor.

**`v2` rule** (half-up, at the currency exponent, decimal arithmetic):

1. Line net = round(quantity × unit price).
2. Group net = sum of line nets per canonical group key `(treatment, reasonCode, rate, country)`.
3. Group tax = round(group net × rate). Group gross = net + tax.
4. Line tax = group tax by largest remainder, tie-break by `sortOrder`.
5. Prices-include-tax: line gross = round(quantity × gross unit price); group gross = sum; group
   net = round(gross / (1 + rate)); group tax = round(net × rate); `payableRounding` = group
   gross − (net + tax), bounded to one minor unit per group. Line tax = group tax by largest
   remainder on line gross (independently of net); line net = group net by largest remainder on
   line gross. `payableRounding` is a **group-level component** that belongs to no line; the lines'
   net and tax sum to the group's net and tax, and `Σ line gross = group net + group tax +
   payableRounding`. The entered gross unit price is persisted as `unitPriceInput`. Positive
   `payableRounding` credits `payable_rounding`, negative debits it.
6. Document equation in document currency, asserted at issuance: `Σ group net + Σ group tax +
   Σ payableRounding − Σ deposit applications gross = payable gross`.
7. **Base-currency components.** Per group: `grossBase = round(gross × rate)`, `taxBase =
   round(tax × rate)`, `payableRoundingBase = round(payableRounding × rate)`, and `netBase =
   grossBase − taxBase − payableRoundingBase`. `debtorBase = Σ grossBase`. The base equation
   `Σ netBase + Σ taxBase + Σ payableRoundingBase = Σ grossBase = debtorBase` holds by
   construction in every case, including non-zero rounding. Translation differences are never a
   line; nothing is routed to FX at issuance. `VatGroup` persists `payableRounding` and
   `payableRoundingBase` as explicit fields.
8. **Partial credits, cumulative entitlement rule.** Per group, with `C` the cumulative credited
   gross including this credit and `P` the cumulative before it: `cumTax(C) = round(groupTax × C
   / groupGross)`, `cumRounding(C) = round(groupPayableRounding × C / groupGross)`, this credit's
   `tax = cumTax(C) − cumTax(P)`, `rounding = cumRounding(C) − cumRounding(P)`, `net = credited
   gross − tax − rounding`. The same rule on the base components with the frozen base totals.
   Because each component is a difference of a monotone rounded function, successive credits can
   never over-reverse, and the credit with `C = groupGross` reverses exactly the group's
   remaining components. Credits never exceed the group's remaining gross. Worked check: gross
   0.08, tax 0.02, credits 0.02, 0.02, 0.03, 0.01 reverse tax 0.01, 0.00, 0.01, 0.00.
9. Discounts, when introduced, are allocated across groups then lines by net before step 2.

Rounding never absorbs FX or legacy differences. A credit note reverses rounding through
`historicalReversal.roundingBase`. UBL reads frozen groups and is versioned.

### Precision

Exponents 0 to 2, rounded at the currency's exponent. Settings refuse other currencies; drafts
refuse them at creation. Existing documents in unsupported currencies keep their figures and are
`postable: false`.

## Part 4: base currency and valuation (A3b); positions (B1)

- `OrgSettings.baseCurrency`, required, defaulted from the country profile, refused to change
  after any issued document. `defaultCurrency` stays the drafting default. Dashboard: per-currency
  buckets plus a labelled base total excluding unknown valuations.
- Valuation frozen at issuance (rate 1 when same currency, else the user confirms a rate).
- **Positions are Phase B.** In A3b, nothing persists a position; credit notes use the settlement
  projection as stated. In B1, `Position(id, organizationId, kind, refId, currency,
  quantityMinor, carryingBase, revaluationRevision, lastRevaluedAt)` becomes authoritative, is
  rebuilt from events in B1's migration, and settlement becomes a projection of allocations.
- Fallback: pre-change documents carry `rateSource: unknown`; `postingsFor` refuses with
  `base_valuation_unknown`; `invoice.base_valuation_recorded` v1 records a reviewed historical
  rate.

## Part 5: renderer, artifacts and the issuance candidate (A3a)

### Interfaces and entrypoints

`DocumentRenderer` and `DocumentArtifactStore` injected through `RuntimeServices`. The Bun React
PDF renderer and the local-disk store live in `apps/oss/src/selfhost/runtime.ts`, imported only by
the self-host server entry; the core app and the published package's default import graph never
reference them.

### One orchestration function

Commands run in one interactive transaction with only the transaction client, so issuance is
orchestrated by **one application-layer function**, `issueDocument({ kind, commandInput, actor,
clientRequestId })` in `apps/oss/src/application/issuance.ts`, called after authorization,
receipt lookup and approval gating by every entry point: tRPC `invoices.send` (including
`allowSendWithoutEmail`), `creditNotes.issue`, `agreements.send` and `agreements.issue`; MCP
`invoice_send`, `credit_note_issue`, `agreement_send`, `agreement_issue`; and **approval execution
and recovery** in `domain/approvals.ts`, which pass the stored command input and request identity
through internal execution options. Resends and re-emails never enter it; they reuse published
artifacts. **Recurring auto-send** (`domain/commands/recurring.ts`, which today calls
`executeCommand(sendInvoice, …)` directly) is routed through `issueDocument` by an injected
dispatcher registered at bootstrap, so the job module never imports the orchestration module and
no import cycle is created.

### Reservation, preparation, commit

1. **Reserve** (own short transaction with the root client, completed before the command
   transaction opens; it locks the `OrgSettings` counter row like `allocateDocumentNumber` and
   `appendEvents` do, and nothing else): **reuse** the document's existing number when it has
   one (invoices receive theirs at draft creation; agreements already have theirs), otherwise
   allocate; create the document id only for documents that do not exist yet (credit notes); fix
   `issuedAt` as the reservation time. The reservation is looked up first by a **stable request
   identity** `(organizationId, actorKey, clientRequestId)` stored on the staging row, so a retry
   of the same request reuses the same id, number and timestamp instead of allocating again; and write `ArtifactStaging(id, organizationId,
   documentKind, documentId, renderInputHash, renderInput JSON, rendererVersion, status:
   reserved, prepToken, leaseUntil, artifacts null, missingReason null, candidateRefs [],
   createdAt)` with unique `(organizationId, documentKind, documentId, renderInputHash)`.
   `renderInput` is the complete render input: prospective snapshot, number, dates, recipient,
   and for credit notes the credit-selection fingerprint. A reservation that is never committed
   consumes its number: the sweep emits `document.number_voided` v1 for it so the sequence stays
   accounted for (verify with an accountant that a documented void satisfies numbering rules).
2. **Prepare** (no transaction): render and `put` from `renderInput`; a compare-and-set on
   `prepToken` moves the row to `stored` with refs and hashes, or to `missing` with
   `missingReason: renderer_unavailable` in the A3a release. A concurrent preparation with the
   same identity waits on the lease; the loser reuses the winner's artifacts.
3. **Commit** (the ordinary command transaction): lock the document; recompute the prospective
   hash and refuse with `document_changed` if it differs from `renderInputHash` (the command
   fails; the staging row is left for the sweep, never retired inside the failing transaction);
   verify approval version and request identity; require the lease to be unexpired (default 15
   minutes, else `reservation_expired`); create the `IssuanceCandidate` (render input, hash,
   recipient, artifact refs, `attemptAt`); append the candidate id to `candidateRefs`; queue the
   email job with `candidateId`; write the receipt. Issue without email publishes in the same
   transaction.
4. **Completion** (delivered or unconfirmed) is bound to `candidateId` and `attemptAt`; it
   publishes state, `document.artifact_stored` or `document.artifact_missing` (and
   `invoice.issued` from A3b on), and marks the candidate `published`. It never prepares.

Flows: definite rejection marks the candidate `retired`; an unchanged retry within the lease
reuses the staging row and artifacts (new candidate, same refs); an edited retry reserves again.
Agreements keep their existing pre-queue issuance and use steps 1 to 3 for their PDF only. Sweep (runs under the same `OrgSettings` lock as commit and completion, so it cannot race
them): a staging row is `abandoned` only when its lease has expired **and** it has no candidate at
all, or every candidate it has is `retired` **and** no delivery job for any of them is queued,
running, or awaiting settlement (`domain/delivery/outbox.ts` permits delayed settlement). A number
is voided (`document.number_voided` v1: organizationId, documentKind, number, reservationId,
reason) only for an abandoned reservation that **allocated** a fresh number; a reused number
belongs to the document and is never voided. Artifact bytes are deleted only when no
`candidate_bound` or `published` staging row and no retired candidate younger than seven days
references them; after seven days a retired candidate no longer protects bytes. Tests: crash
after `put`; lease expiry before commit; concurrent preparation; concurrent edit between reserve
and commit; rejection then unchanged retry then sweep (bytes survive); rejection then edited retry
(old bytes swept, new kept); approval execution whose stored snapshot differs from the render
input; number voided for an abandoned reservation that allocated; number **not** voided for a reused
invoice number; delayed settlement arriving after the lease expired but with the candidate's job
still unsettled (publishes, nothing voided); retry with the same client request id reuses the
reservation.

### Cloud gates and release sequencing

- **Cloud 0** (quits-cloud, a prerequisite of the A3a **release**): `sync-oss-release.yml` opens
  a pull request instead of pushing to `main`. A new harness, `scripts/check-oss-release-compat.sh`,
  installs the exact pinned tarballs with sibling substitution disabled, runs an adapted generator
  that produces the runtime's actual client (`packages/app-runtime`'s `@prisma/client`) from the
  release's schema, applies the release's migrations to a disposable database seeded with upgrade
  fixtures and migration history, boots the worker locally with `wrangler dev` (workerd), and runs
  an authenticated issuance. Expectations are keyed by the release's advertised capability
  `documents.artifactsRequired` (a new runtime capability exposed by OSS): `false` expects success
  with `document.artifact_missing` when no renderer is configured; `true` expects
  `renderer_unavailable` without adapters and a stored artifact with a verified hash with them.
- **A3a release**: artifacts optional; `artifactsRequired = false`.
- **Cloud 1**: renderer and store adapters for Workers; the harness passes with adapters.
- **A3b release**: `artifactsRequired = true`. The sync PR for it fails its check unless Cloud 1
  is merged.

Issued documents download stored bytes; drafts render live. Legacy documents get
`legacy_reconstructed` artifacts in C4.

## Part 6: event log as outbox (A1)

As implemented in A1: scanned versus acknowledged positions, delivery rows per scanned event with
`skipped`, claim-token fencing, compare-and-set cursor, bounded unfiltered scans. Delivery row id
is the remote idempotency key.

## Part 7: agreements amendment (Agreements Phase 2) and Phase A posting of deliverable invoices

- **Offer format version.** An **absent** `offerFormatVersion` means v1. v1 snapshots (deposit
  included in total) keep their serialized bytes, canonical hashing and pinned fixtures byte for
  byte; no default is ever injected into v1 hash input. Readers, builders and renderers dispatch
  explicitly on presence of the field: the v1 builder is frozen as is, and A2a adds no field to
  it. New drafts produce `offerFormatVersion: 2` with `serviceTotal` (service lines only),
  `paymentSchedule[]` (deposit lines with amount, trigger, VAT group attribution),
  `calculationVersion`, `originalInputs`, frozen VAT groups. Amounts state their VAT basis.
  v2 fixtures are separate from the v1 fixtures.
- **Invoicing from deliverables** (`invoice.create_from_deliverables`): creates drafts and
  reserves deliverables in one transaction; a selection containing schedule lines and service
  lines creates two drafts atomically with the named result `{ saleInvoiceId?,
  prepaymentInvoiceId? }` and one command receipt; failure creating the second rolls back both; not
  outward-facing; issuance is per invoice afterwards. `purpose = prepayment` drafts **may be
  created** in Phase 2 but their issuance is refused with `purpose_issuance_not_supported` until
  C1, so a user who wants the money now invoices the schedule line as a `sale` line by explicit
  choice (recorded on the draft). Reservation and uniqueness rules of the agreements design are
  unchanged; no `advanced` status.
- Phase A posting covers `sale` invoices raised from deliverables. `prepayment` invoices and
  applications are Phase C and refused by A4.

## Part 8: closed periods (C2, draft)

`OrgSettings.booksClosedThrough`, `FinancialYear` table preserving historical boundaries,
`assertOpenPeriod` in every money command, late receipts keep dates and get `periodAdjustment`,
recurring runs pause, closing refused with pending attempts. Open issue: amendment decisions for
late corrections (review 2, finding 14).

## Part 9: retention and erasure (C3, C5, draft)

C3a disables Better Auth organization deletion; C3b changes the audited cascades to `Restrict`
with explicit child deletion and bottom-up fixture cleanup in one PR. C5 (draft): `financialYearsSupported[]` per item with **transitive propagation** to the evidence a posting's
document references (artifacts, agreement, approval requests, sent emails), holds, purge refusing
unknown years, backup policy stated in docs, contact and user profile deletion with tombstones,
ancillary expiry only for items unreachable from any posting.

## Part 10: the posting function (A4, Phase A scope)

`domain/accounting/postings.ts` exports `postingsFor(event): Posting[] | PostingRefusal`, pure.
Roles in Phase A: `debtor`, `revenue`, `output_vat`, `payable_rounding`, `fx_gain`, `fx_loss`,
`customer_credit`. Debits equal credits in base minor units, asserted at construction. **Signed components:** every component amount in an event may be negative after the difference rules of Part 3; a line is built from a signed amount by putting its absolute value on the debit side when the intended direction and sign agree and on the credit side otherwise, so no component is ever dropped or clamped.

| Event | Posting |
| --- | --- |
| `invoice.issued` sale | Dr `debtor` gross base; Cr `revenue` net base per group; Cr `output_vat` tax base per group (zero-tax treatments post no VAT line; group retained); `payable_rounding` per sign. |
| `credit_note.issued` (postable) | Reverse each credited base component as a **signed** line: revenue, output VAT and payable rounding are posted as Dr when the component is positive and as Cr when it is negative (a derived negative base net at an unfavourable rate is a Cr `revenue`); Cr `debtor` at `debtorDischarge.carryingBase`, which equals the signed sum. No FX line in Phase A. |

Refusals, each a typed `PostingRefusal` with a fixture proving it: `base_valuation_unknown`,
`not_postable` (sparse v1, legacy currency, any `incompleteReason`), `tax_point_review_required`
(including `taxPointDate ≠ issueDate` for `invoice_issued`, and `assessment_required`),
`unsupported_treatment_combination` (`out_of_scope` mixed, `unclassified_zero`, `zero_rated`,
`reverse_charge_domestic`, missing or non-valid evidence, `standard` with rate 0),
`purpose_not_supported` (`prepayment`, or a credit whose `correctsPurpose` is not `sale`),
`advances_not_supported`, `applications_not_supported`, `equation_violation` (either document
equation fails on the frozen components), `event_not_supported` (any Phase B or C event type).

### Phase A acceptance tests

Each asserts balance **and** ending balances per role and VAT group, through an in-memory
ledger in the test helper:

1. Sale with 25% standard and an intra-community goods line (K); refused without buyer VAT id or
   VIES result.
2. Intra-community B2B services (AE); export goods (G); domestic exempt (E).
3. Inclusive pricing, two lines of 0.01 at 25%: group net 0.02, tax 0.01, rounding −0.01; line
   tax sums to 0.01 and line net to 0.02 independently; full cancellation reverses every
   component including rounding.
4. Credits 0.02, 0.02, 0.03, 0.01 on an invoice with net 0.06, tax 0.02, gross 0.08: reversed
   tax 0.01, 0.00, 0.01, 0.00, cumulative never exceeds 0.02, the last credit exhausts the group
   exactly; a fifth credit is refused.
4b. EUR invoice net 0.03, tax 0.01, gross 0.04 at 7.45: base components 0.30, 0.07, 0.23; two
   inclusive EUR 0.01 lines at 7.4567 with rounding −0.01: base gross 0.15, tax 0.07, rounding
   −0.07, net 0.15; debtor base 0.15; the credit rule on base components balances for both.
4c. Intra-community services with valid evidence but rate 25%: refused.
4d. Gross 0.05, tax 0.01 at rate 0.8 (base 0.04, 0.01, 0.03), five credits of 0.01: the third
   credit's base net is −0.01 and posts as Cr `revenue` 0.01 beside Dr `output_vat` 0.01; every
   credit balances and the five sum to the frozen components.
5. Credit note on an invoice with a payment: refused `allocations_pending`; credit on a prepayment
   invoice: `purpose_not_supported`; credit exceeding open balance after a prior credit: refused.
6. Non-VAT-registered seller: all lines `out_of_scope`; mixing refused; `standard` with rate 0
   refused; `reverse_charge_domestic` and `zero_rated` refused; VIES `invalid` refused.
7. `supplyDate` one day before `issueDate`: `tax_point_review_required`; equal: postable; null on a
   legacy document: refused.
8. Legacy invoice without valuation: `base_valuation_unknown`; `unclassified_zero` line: refused.
9. Prepayment invoice, covered advance, deposit application, any Phase B event: refused with the
   named reason.
10. Document equation holds for every fixture; `vatReporting` carried and ignored by postings.

### The note

`docs/architecture/posting-roles.md`: roles and why each exists, the Phase A table, refusal
catalogue, the three dates and the tax-point window, the carrying-value principle, the rounding
rule and document equation, the precision limit, the reporting-only VAT rate, and: "the sync worker
and the ledger module both consume `postingsFor`; neither reads document rows."

## Known open issues for Phases B and C (needs a bookkeeper)

Kept verbatim in spirit from review round 3 so a human can decide:

- Covered advances across currencies (review 3, finding 29): freeze receipt quantity, covered
  invoice quantity, agreed conversion, recognition and base components, and residual ownership;
  distinguish face, covered and outstanding gross; refuse currency changes until defined.
- Deposit conservation (findings 20, 30, 31): funded credits followed by refunds, full
  cancellation; separate advance liability from credit-created refund liability; applications
  unique per VAT group; refund allowed to zero; partial application releases bounded by the
  credited supply portion with residual tracking; allocation releases as journals or metadata,
  never both (double customer-credit risk).
- Credits against prepayment invoices debit the prepayment liability and VAT, not revenue
  (finding 31).
- The final-invoice FX bridge when the advance and the final invoice carry different rates (the
  6.25 DKK example, finding 32); fixed-service advances versus monetary refund obligations;
  historical VAT components kept separate.
- Fee postings (finding 34): assert `deductibleTax + nonDeductibleTax = selfAssessedTax`; FX on
  every treatment when clearing carrying differs from valuation.
- Deferred acceptance fixtures (finding 40): partial covered advances, cross-currency
  recognition, funded credit then refund, full cancellation and refund, partial application
  release, exhausted-position reversal, false-receipt correction after revaluation, foreign
  reverse-charge fee, delivery before late invoice, transitive retention.
- Reversal valuation on exhausted positions; void after revaluation as a correction workflow.
- Fee postings with clearing carrying different from valuation; FX on every treatment.
- Delivery before late invoicing: accrue, or keep as a refusal.
- Backdated allocations after revaluation: chronological recomputation versus explicit correction.
- Write-off recovery valuation and cumulative residuals.
- Retention: transitive evidence, holds, backups.

## Phases and pull requests

| PR | Scope | Depends on |
| --- | --- | --- |
| A1 | Part 1, Part 6. In implementation. | nothing |
| A2a.1 | Additive: `@quits/shared/pricing` decimal calculator (string inputs, number compatibility, independent input precision) with packed-package verification; VAT treatment columns, evidence JSON, contracts; `calculationVersion`, `quantityInput`, `unitPriceInput` columns with backfill; precision rule at settings and drafts. Legacy execution path unchanged; v2 not yet produced. | A1 |
| A2a.2 | Activation: every producer on v2 (invoice and quote create and edit including no-item edits that reconstruct from Decimal columns, quote conversion, recurring generation, agreement pricing for v2 offers); every editor on the shared calculator; `calculationVersion` propagation. | A2a.1 |
| A2b | Version-aware credit pricing with residuals and rounding reversal; versioned UBL with the K, G, AE, E, O mapping. | A2a.2 |
| A3a | Part 5: interfaces, self-host entrypoint, `issueDocument` orchestration used by all entry points and approval recovery, reservation and staging protocol, candidate, sweep with number voiding, `document.artifact_stored` and `document.artifact_missing`, `documents.artifactsRequired` capability. Merge gates: packaged cloud compile; the eleven protocol tests. | A1 |
| Cloud 0 | Gated sync PR with `check-oss-release-compat.sh`. Prerequisite of the A3a release. | nothing |
| Cloud 1 | Workers renderer and store adapters; harness passes with adapters against the published A3a release. | A3a released, Cloud 0 |
| Agreements Phase 2 | Offer format v2 with absent-means-v1 dispatch, invoicing from deliverables on `issueDocument`, two-draft command, `purpose` column with prepayment issuance refused. | A3a, A2a.2 |
| A3b | Part 4 base currency and valuation; `invoice.issued` v1; `credit_note.issued` v2 with the transition rule; buyer tax ids; `supplyDate` input and tax-point rule; stored downloads; dashboard buckets; `artifactsRequired = true`. | A2b, A3a, Cloud 1, Agreements Phase 2 |
| A4 | Part 10 Phase A, refusal catalogue, tests 1 to 10, the note. | A3b |
| B1 to B4, C1, C2, C5 | Draft; briefs only after the open issues are decided. | A4 |
| C3a, C3b | Disable Better Auth deletion; Restrict cascades with explicit deletion and fixtures. | nothing; C3a |
| C4 | Backfill reconciled events and legacy artifact reconstruction. | B1, A3b |

## Decisions taken in review round 4 (Phase A)

- No tax-point window: any `supplyDate` before `issueDate` is refused for posting until an
  accountant approves a safe harbour; null never bypasses review.
- `zero_rated` stays in the vocabulary and is refused throughout Phase A.
- Agent API and new routes require decimal strings; numeric compatibility is UI-transition only
  and uses full precision, not `toFixed`.
- Status line: revision 5 incorporates the round-4 accounting findings 1 to 8; revision 6 the
  round-5 counterexamples (cumulative entitlement for partial credits, rounding in base net,
  zero rate on non-standard treatments, canonical key in step 2); revision 7 the round-6 signed
  component rule. Round 6 confirmed every other Phase A arithmetic rule with fresh counterexamples.

## Known open issues and conservative choices in A3b implementation

- Payment valuation belongs to Phase B. Dashboard receipts and outstanding balances are grouped
  by document currency. Its labelled base total is issued invoice value after credits, excluding
  any invoice whose valuation or a credit valuation is unknown. It does not convert received cash
  at the invoice's historical rate.
- Base currency also stays locked while an issuance candidate is awaiting delivery settlement.
  Otherwise an immutable candidate could publish an obsolete base currency after a settings edit.
  Historical issuance events keep the lock after recall or a later lifecycle change.
- Optional UBL is stored only when the renderer has complete Peppol data. Issued documents with
  no stored PDF or UBL refuse downloads; C4 still owns legacy reconstruction. A later workflow
  for completing missing Peppol data must produce an explicit new artifact, not silently rerender.
- A credit does not copy the invoice's whole reporting-only `vatReporting` amounts. A per-credit
  VAT-return allocation policy has not been specified; those optional fields remain absent until
  that policy is approved. Accounting reversal always uses frozen base components.
- Credit selection retains the existing two-decimal quantity limit. MCP requires decimal strings;
  six-decimal partial credit quantities need a separate residual-ownership and storage change.

- A bound candidate queued before A3b keeps its frozen A3a input when delivery settles. It is
  published with explicit unknown valuation and no invented money event. A3a candidates that
  lack artifacts may finish their already queued delivery with `document.artifact_missing`;
  newly requested issuance requires both adapters. C4 must reconcile that historical gap.
- Agreement prepayment drafts retain Phase 2's `purpose_issuance_not_supported` refusal.
  Explicitly converted sale drafts receive the same valuation and date snapshot as other sales.
- Historical valuation recording requires a human actor and balancing stored components. It
  refuses incomplete historical rows rather than inferring their missing amounts or tax treatment.

## Known open issues and verification boundaries in A4 implementation

- The shared currency catalogue has no supported exponent-1 currency, although the money contract
  allows exponents 0, 1 and 2. A4 uses the existing currency guard and refuses unsupported currencies
  with `not_postable`; it does not extend pricing or the catalogue. Unit fixtures cover current
  exponent-0 and exponent-2 currencies.
- Unsupported treatment/rate/evidence combinations cannot be emitted by successful A3b issuance.
  Likewise prepayment issuance is blocked, advance/application arrays are reserved empty, and new
  issuance requires valuation. Acceptance refusal probes therefore perturb policy facts on real
  `issueDocument` events. Supported invoices and credits, the paid incomplete credit, earlier-supply
  review and payment event are unmodified real emitted events. A separate calculator-built pure
  catalogue covers legacy/sparse events and all refusals. No emitter is changed or bypassed.
