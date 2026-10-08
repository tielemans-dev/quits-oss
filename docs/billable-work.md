# Billable work and reservations

Work on an accepted agreement is billed by reserving it on a draft invoice. This page describes how
that reservation behaves and the contract any future billable source follows.

## What is supported

| Source | Status |
| --- | --- |
| Agreement deliverables | Supported. |
| Time entries | Not supported. The name is reserved. |
| Expenses | Not supported. The name is reserved. |
| Scheduled billing | Not supported. Nothing bills work on a schedule, so no scheduled state is shown. |

The agreement page and the invoice dialog say the same.

## States

Each deliverable shows one billing state, derived from the invoice line that allocates it and the
credit notes issued against that invoice:

- **Unbilled**: no invoice line holds it.
- **Reserved**: a draft invoice holds it. The page links to that draft (when you may read invoices)
  and offers **Release from draft** (when you may update invoices).
- **Invoiced**: an issued invoice holds it.
- **Partly credited / Credited**: the invoice line was credited in part or in full by line credits.
  A credit note never returns work to unbilled.

A draft has no number until it is issued, so a holding draft is shown as "Draft".

## Reservation rules

- Creating a draft or adding to one reserves the selected work in the same transaction as the draft.
  If anything fails, nothing is reserved.
- Removing the line from a draft, deleting the draft, or releasing the line releases the reservation
  once. A second release is refused with `not_reserved`. Releasing the last line is refused with
  `last_invoice_line`; open and delete the eligible draft to free that work, or add another line
  first. A release never leaves an empty draft that could be issued.
- Two requests for the same work cannot both succeed. The loser receives `deliverable_reserved` (or
  `deliverable_already_invoiced`). Its `details` carry `deliverableId` and, when the caller may read
  invoices, `holdingInvoiceId`, `holdingInvoiceNumber` (null for a draft) and `holdingInvoiceStatus`.
- The database allows one invoice line for each `(deliverableId, allocationGeneration)` and each
  `(sourceKind, sourceId, allocationGeneration)`, so the guard holds even if a code path skips the
  application check.
- `deliverable.release_reservation` needs `invoice:update`. It refuses work on an issued invoice and
  a draft that is being emailed. Its strict input requires `expectedAllocation` with `invoiceId`,
  `invoiceItemId` and `generation`, copied from the reviewed allocation holder and generation.
  The handler locks the agreement before reading the allocation, then locks the invoice. If the
  holder, line identity or generation changed, it refuses with `allocation_changed`. Refresh and
  review the current draft before retrying. Missing expected identity is refused at validation.

## Credits and rebilling

A credit note does not make work billable again. After a partial credit, an amount credit that is
not tied to a line, or a full credit, the work stays invoiced and creating a draft is refused with
`deliverable_already_invoiced`.

To bill credited work again, a person records a decision with `deliverable.authorize_rebill`
(`invoice:create`; agents receive `human_review_required`):

- the agreement must still be accepted; completed and cancelled agreements receive
  `agreement_not_accepted`. A rebill never reopens an agreement;
- the reviewed credit notes must together credit the work's current invoice line in full. Every
  note must be issued and tied to that line. Several partial credits can satisfy this rule;
- `creditNoteIds` names the exact reviewed set, without duplicates. The required `creditNoteId`
  remains its primary reference for compatibility and must belong to that set. Omitting
  `creditNoteIds` means only the primary note was reviewed, so that note must cover the full line;
- the confirmation names every contributing note and retains those IDs while open. New or different
  credits are not silently added to a decision after review;
- the decision and event store who decided, why, the prior invoice and every reviewed credit-note ID.
  Those IDs identify the immutable issued line credits that justify the decision;
- the deliverable moves to the next allocation generation and becomes unbilled. The next draft line
  records that generation, so it points back at the prior invoice and credit. The prior invoice and
  its line are not changed.

Credit the rest of a partly credited line first, then review all contributing notes together. To bill
only a remainder, add a manual line.

## Source identity contract

`@quits/contracts/billing` defines the contract for every billable source, including future time and
expense adapters:

1. **Stable identity.** The source has an immutable Quits id. Imported work is stored first, with a
   unique `(organization, provider, external id)`, so re-importing never creates a second source.
2. **One active allocation.** An invoice line records `sourceKind`, `sourceId` and
   `allocationGeneration`, and the source's billing state changes by compare-and-set in the
   transaction that creates the line.
3. **Frozen line.** The line copies description, quantity, price and VAT and records `sourceRevision`.
   Later changes to the source or to external data never rewrite it. Legacy lines whose billed
   revision cannot be proved retain `sourceRevision: null`, even when the current source has a revision.
4. **Credits do not release work.** Only a recorded rebill decision advances the generation.

Adding a source kind means adding it to the contract, writing its allocate and release steps against
these guards, and listing it as supported in the interface.

Allocation views redact historical invoice IDs and numbers without `invoice:read`, and historical
credit note IDs and numbers without `creditNote:read`. Each permission applies independently.

Agreement detail and allocation reads run in one PostgreSQL repeatable-read transaction. The page,
`agreement_get` and `deliverable_list` therefore return a coherent state, holder, generation, credit
set and history even when a release, reservation or rebill commits between their queries.

## Migration and upgrade notes

The follow-up corrects `20261010000000_billable_allocation_identity` before this batch's first
release. Its backfill sets source kind and ID but leaves the billed revision unknown. A mutable
`deliveryRevision` cannot prove what an older invoice billed. The separate
`20261010010000_billable_rebill_credit_evidence` migration adds the reviewed credit-note array; it
never updates invoice-line revisions or amounts. New allocations continue to capture their real
source revision at creation.

If an environment already applied the earlier allocation migration, editing its SQL does not repair
its data or reconcile its migration checksum. Recreate disposable databases before verifying this
batch. For a retained database, first inventory which rows predate the allocation migration using
an immutable pre-migration backup or other row-level evidence, then prepare a scoped repair and
reconcile migration history through the deployment owner. Do not null every deliverable revision:
that would destroy genuine revisions captured by later allocations. No such retained-database
repair or deployment is part of this correction.

Existing rebill rows receive an empty `creditNoteIds` array because their complete reviewed set was
not recorded. Their primary reference remains available in history. Do not reconstruct a reviewed
set from all credits visible today, since those may postdate the decision. If this unreleased code
has been used with retained data, historical cumulative-credit decisions need an evidence audit.
New decisions always store the reviewed set, including a one-element set for single-note callers.

## Kvit handoff

Keep the existing agreement allocation panel and confirmation. Show all contributing credit-note
numbers in the confirmation and all recorded notes in the history. Retain the reviewed IDs when
opening the dialog. On `last_invoice_line`, explain the existing delete-draft or add-line recovery;
keep the draft link and reservation visible. No new screen is required. Cumulative full-credit
rebilling remains supported; partial or untied credits alone do not release work.
