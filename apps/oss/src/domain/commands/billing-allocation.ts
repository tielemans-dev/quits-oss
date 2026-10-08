import { Effect } from "effect"
import { Prisma } from "../../../generated/prisma/client"
import { deliverableAuthorizeRebillInputSchema, deliverableReleaseReservationInputSchema } from "@quits/contracts/billing"
import { actorKey } from "../actor"
import { defineCommand } from "../command"
import { refuseWhileSending } from "../documents/document-delivery"
import { lockDocument } from "../documents/locks"
import { frozenTotals, releaseLines } from "../agreements/billing"
import { lockedAgreement } from "../agreements/issuance"
import { InvalidState, NotFound } from "../errors"
import { Command, Db } from "../services"

/**
 * Takes one deliverable out of the draft that holds it, so another draft can bill it. The same
 * release happens when a draft line is removed or the draft is deleted. Never touches an invoice
 * that has been issued.
 */
export const releaseDeliverableReservation = defineCommand({
  type: "deliverable.release_reservation", permission: "invoice:update", outwardFacing: false,
  input: deliverableReleaseReservationInputSchema,
  summarize: input => `Release deliverable ${input.deliverableId} from its draft invoice`,
  handle: input => Effect.gen(function* () {
    const db = yield* Db, command = yield* Command
    const line = yield* Effect.promise(() => db.deliverable.findFirst({ where: { id: input.deliverableId, agreementId: input.agreementId, agreement: { organizationId: command.organizationId } } }))
    if (!line) return yield* new NotFound({ message: "Deliverable not found", entity: "deliverable", id: input.deliverableId })
    const held = yield* Effect.promise(() => db.invoiceItem.findFirst({ where: { deliverableId: line.id, allocationGeneration: line.billingGeneration }, select: { invoiceId: true } }))
    if (line.billingStatus !== "reserved" || !held)
      return yield* new InvalidState({ code: "not_reserved", message: line.billingStatus === "invoiced" ? "This work is on an issued invoice and cannot be released" : "This work is not reserved by a draft" })
    // Parent first: this locks the agreement, then the invoice, like every other draft editor.
    yield* lockDocument("invoice", held.invoiceId)
    const invoice = yield* Effect.promise(() => db.invoice.findFirst({ where: { id: held.invoiceId, organizationId: command.organizationId }, include: { items: { orderBy: { sortOrder: "asc" } } } }))
    const item = invoice?.items.find(row => row.deliverableId === line.id && row.allocationGeneration === line.billingGeneration)
    if (!invoice || !item) return yield* new InvalidState({ code: "not_reserved", message: "This work was released while you were deciding" })
    if (invoice.status !== "draft") return yield* new InvalidState({ code: "not_draft", message: "Only a draft invoice can release work" })
    yield* refuseWhileSending("invoice", invoice)
    const remaining = invoice.items.filter(row => row.id !== item.id)
    const choice = invoice.scheduleSaleChoice as { deliverableIds?: string[] } | null
    yield* Effect.promise(() => db.invoiceItem.delete({ where: { id: item.id } }))
    yield* Effect.promise(() => db.invoice.update({ where: { id: invoice.id }, data: {
      ...frozenTotals(remaining),
      ...(choice?.deliverableIds?.includes(line.id) ? { scheduleSaleChoice: { ...choice, deliverableIds: choice.deliverableIds.filter(id => id !== line.id) } } : {}),
    } }))
    yield* releaseLines(input.agreementId, invoice.id, [item])
    command.emit({ aggregateType: "invoice", aggregateId: invoice.id, type: "invoice.draft_updated", payload: { fields: ["deliverables"] } })
    return { invoiceId: invoice.id, invoiceNumber: invoice.number, remainingLines: remaining.length }
  }),
})

/**
 * Lets credited work be billed again. A credit note alone never does this: a person records the
 * decision, naming the credit note that justifies it, and only for a line the credit covered in
 * full. The prior invoice and its line stay exactly as issued; the next allocation is a new
 * generation that points back at them.
 */
export const authorizeDeliverableRebill = defineCommand({
  type: "deliverable.authorize_rebill", permission: "invoice:create", outwardFacing: false,
  input: deliverableAuthorizeRebillInputSchema,
  summarize: input => `Allow deliverable ${input.deliverableId} to be billed again after credit note ${input.creditNoteId}`,
  handle: input => Effect.gen(function* () {
    const db = yield* Db, command = yield* Command
    if (command.actor.kind !== "user") return yield* new InvalidState({ code: "human_review_required", message: "A person must decide whether credited work is billed again" })
    const agreement = yield* lockedAgreement(input.agreementId)
    const line = agreement.deliverables.find(row => row.id === input.deliverableId)
    if (!line) return yield* new NotFound({ message: "Deliverable not found", entity: "deliverable", id: input.deliverableId })
    if (line.billingStatus !== "invoiced") return yield* new InvalidState({ code: "rebill_not_invoiced", message: "Only work on an issued invoice can be rebilled" })
    const item = yield* Effect.promise(() => db.invoiceItem.findFirst({ where: { deliverableId: line.id, allocationGeneration: line.billingGeneration }, include: { invoice: { include: { creditNotes: { where: { status: "issued" }, include: { items: true } } } } } }))
    if (!item) return yield* new InvalidState({ code: "rebill_not_invoiced", message: "This work has no issued invoice line" })
    const credit = item.invoice.creditNotes.find(row => row.id === input.creditNoteId)
    if (!credit || !credit.items.some(row => row.invoiceItemId === item.id))
      return yield* new InvalidState({ code: "credit_note_mismatch", message: "The credit note must be an issued credit of this work's invoice line" })
    const credited = item.invoice.creditNotes.flatMap(row => row.items).filter(row => row.invoiceItemId === item.id).reduce((sum, row) => sum.plus(row.quantity), new Prisma.Decimal(0))
    if (credited.lt(item.quantity))
      return yield* new InvalidState({ code: "line_not_fully_credited", message: `Only ${credited.toString()} of ${item.quantity.toString()} was credited. Credit the rest of the line first; a partial credit does not release the work.`, details: { credited: credited.toString(), quantity: item.quantity.toString() } })
    const moved = yield* Effect.promise(() => db.deliverable.updateMany({ where: { id: line.id, agreementId: agreement.id, billingStatus: "invoiced", billingGeneration: line.billingGeneration }, data: { billingStatus: "unbilled", billingGeneration: { increment: 1 } } }))
    if (moved.count !== 1) return yield* new InvalidState({ code: "rebill_not_invoiced", message: "This work changed while you were deciding" })
    const generation = line.billingGeneration + 1
    yield* Effect.promise(() => db.deliverableRebill.create({ data: {
      agreementId: agreement.id, deliverableId: line.id, generation, priorInvoiceId: item.invoiceId, priorInvoiceItemId: item.id,
      creditNoteId: credit.id, reason: input.reason, decidedBy: actorKey(command.actor), commandId: command.commandId,
    } }))
    command.emit({ aggregateType: "agreement", aggregateId: agreement.id, type: "deliverable.rebill_authorized", payload: { deliverableId: line.id, invoiceId: item.invoiceId, creditNoteId: credit.id, generation } })
    return { deliverableId: line.id, generation, priorInvoiceId: item.invoiceId, creditNoteId: credit.id }
  }),
})

export const billingAllocationCommands = [releaseDeliverableReservation, authorizeDeliverableRebill] as const
