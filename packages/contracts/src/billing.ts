import { z } from "zod"

/**
 * Billable-source identity contract.
 *
 * A billable source is a unit of work that can be allocated to an invoice line. Today the only
 * implemented kind is an agreement deliverable. The other kinds are reserved names for future
 * time and expense adapters and are NOT accepted by any command yet.
 *
 * Every source kind must satisfy these rules so adapters can reuse the allocation guards:
 *
 * 1. **Stable identity.** The source has an immutable Quits id. Imported work is stored in a Quits
 *    row first, with a unique natural key (organization, provider, external id), so re-importing
 *    the same external record never creates a second billable source.
 * 2. **One active allocation.** An invoice line records `(sourceKind, sourceId,
 *    allocationGeneration)`. The database allows at most one line for that triple, and the source's
 *    billing state changes by compare-and-set inside the transaction that creates the line.
 * 3. **Frozen line.** Allocation copies the commercial values (description, quantity, price, VAT)
 *    into the invoice line and records `sourceRevision`, the source revision billed. Later changes
 *    to the source or to external data never rewrite the line.
 * 4. **Credits do not release work.** A credit note never returns a source to unbilled. Only an
 *    explicit, recorded rebill decision advances `allocationGeneration`, and only for work that its
 *    invoice line has fully credited.
 */
export const billableSourceKindSchema = z.enum(["deliverable"])
export const reservedBillableSourceKindSchema = z.enum(["time_entry", "expense"])

export const billableSourceRefSchema = z.strictObject({
  kind: billableSourceKindSchema,
  id: z.string().min(1),
})

/** What a person sees for a billable source. `scheduled` is deliberately absent: nothing schedules billing yet. */
export const billableAllocationStateSchema = z.enum(["unbilled", "reserved", "invoiced", "partially_credited", "credited"])

export const supportedBillableSources = {
  implemented: ["deliverable"],
  notSupported: ["time_entry", "expense", "scheduled_billing"],
} as const

export const deliverableReleaseReservationInputSchema = z.strictObject({
  agreementId: z.string().min(1),
  deliverableId: z.string().min(1),
})

export const deliverableAuthorizeRebillInputSchema = z.strictObject({
  agreementId: z.string().min(1),
  deliverableId: z.string().min(1),
  creditNoteId: z.string().min(1),
  reason: z.string().trim().min(3).max(1000),
})

export type BillableSourceRef = z.infer<typeof billableSourceRefSchema>
export type BillableAllocationState = z.infer<typeof billableAllocationStateSchema>
