import { addUtcDays } from "../features/recurring-dates"
import { formatIsoDate } from "../../lib/exports/format"
import { Effect } from "effect"
import { z } from "zod"
import { invoiceCreateFromDeliverablesInputSchema, invoiceAddDeliverablesInputSchema } from "@quits/contracts/invoices"
import { Prisma } from "../../../generated/prisma/client"
import { billingProvider } from "../../lib/billing"
import { assertCloudOnboardingComplete } from "../../lib/onboarding/guard"
import { actorKey } from "../actor"
import { defineCommand } from "../command"
import { Command, Db } from "../services"
import { InvalidState, NotFound } from "../errors"
import { lockDocument } from "../documents/locks"
import { refuseWhileSending } from "../documents/document-delivery"
import { billableSelection, frozenInvoiceLine, frozenTotals, reserveLines } from "../agreements/billing"

const include = { items: { orderBy: { sortOrder: "asc" as const } } }
const requireCreation = Effect.gen(function* () {
  const { organizationId } = yield* Command
  yield* Effect.tryPromise({
    try: async () => { await assertCloudOnboardingComplete(organizationId); await billingProvider.assertInvoiceCreationAllowed(organizationId) },
    catch: error => new InvalidState({ code: "precondition_failed", message: error instanceof Error ? error.message : "Invoice creation is not allowed" }),
  })
})
export const createInvoiceFromDeliverables = defineCommand({
  type: "invoice.create_from_deliverables", permission: "invoice:create", outwardFacing: false,
  input: invoiceCreateFromDeliverablesInputSchema,
  summarize: input => `Invoice ${input.deliverableIds.length} deliverables`,
  handle: input => Effect.gen(function* () {
    const db = yield* Db, command = yield* Command
    const { agreement, lines } = yield* billableSelection(input.agreementId, input.deliverableIds)
    const result: { saleInvoiceId?: string; prepaymentInvoiceId?: string } = {}
    const issueDate = input.issueDate ? new Date(input.issueDate) : command.now
    const supplyDate = new Date(formatIsoDate(issueDate, agreement.timezone))
    const dueDate = input.dueDate ? new Date(input.dueDate) : addUtcDays(supplyDate, agreement.dueInDays)
    for (const purpose of ["sale", "prepayment"] as const) {
      const selected = lines.filter(line => (line.isDeposit && !input.scheduleAsSale ? "prepayment" : "sale") === purpose)
      if (!selected.length) continue
      yield* requireCreation
      const rows = selected.map((line, index) => frozenInvoiceLine(line, index, agreement.pricesIncludeTax))
      const saleIds = selected.filter(line => line.isDeposit && input.scheduleAsSale).map(line => line.id)
      const invoice = yield* Effect.promise(() => db.invoice.create({ data: {
        organizationId: command.organizationId, agreementId: agreement.id, contactId: agreement.contactId,
        purpose, status: "draft", issueDate, dueDate, supplyDate,
        ...frozenTotals(rows), calculationVersion: agreement.calculationVersion,
        currency: agreement.currency, countryCode: agreement.countryCode, locale: agreement.locale,
        timezone: agreement.timezone, taxRegime: agreement.taxRegime, pricesIncludeTax: agreement.pricesIncludeTax,
        sellerSnapshot: agreement.sellerSnapshot ?? Prisma.DbNull, buyerSnapshot: agreement.buyerSnapshot ?? Prisma.DbNull,
        vatEvidence: agreement.vatEvidence ?? Prisma.DbNull,
        ...(saleIds.length ? { scheduleSaleChoice: { deliverableIds: saleIds, actor: actorKey(command.actor), commandId: command.commandId, at: command.now.toISOString() } } : {}),
        items: { create: rows },
      }, include }))
      command.emit({ aggregateType: "invoice", aggregateId: invoice.id, type: "invoice.draft_created", payload: { number: invoice.number, contactId: invoice.contactId, totalGross: invoice.totalGross.toNumber() } })
      yield* reserveLines(agreement.id, invoice.id, selected)
      if (purpose === "sale") result.saleInvoiceId = invoice.id
      else result.prepaymentInvoiceId = invoice.id
    }
    return result
  }),
})

export const addInvoiceDeliverables = defineCommand({
  type: "invoice.add_deliverables", permission: "invoice:update", outwardFacing: false,
  input: invoiceAddDeliverablesInputSchema,
  summarize: input => `Add ${input.deliverableIds.length} deliverables to invoice ${input.id}`,
  handle: input => Effect.gen(function* () {
    const db = yield* Db, command = yield* Command
    // The parent is immutable. Refuse a mismatch before taking either agreement lock,
    // so two crossed requests cannot lock each other's agreements in reverse order.
    const parent = yield* Effect.promise(() => db.invoice.findFirst({ where: { id: input.id, organizationId: command.organizationId }, select: { agreementId: true } }))
    if (!parent) return yield* new NotFound({ message: "Invoice not found", entity: "invoice", id: input.id })
    if (parent.agreementId !== input.agreementId) return yield* new InvalidState({ code: "agreement_mismatch", message: "The draft must be linked to this agreement" })
    const { agreement, lines } = yield* billableSelection(input.agreementId, input.deliverableIds)
    yield* lockDocument("invoice", input.id)
    const invoice = yield* Effect.promise(() => db.invoice.findFirst({ where: { id: input.id, organizationId: command.organizationId }, include }))
    if (!invoice) return yield* new NotFound({ message: "Invoice not found", entity: "invoice", id: input.id })
    if (invoice.status !== "draft") return yield* new InvalidState({ code: "not_draft", message: "Only draft invoices can reserve deliverables" })
    if (input.expectedRevision !== undefined && input.expectedRevision !== invoice.editRevision)
      return yield* new InvalidState({ code: "stale_draft", message: "This draft changed since it was loaded. Reload it before saving." })
    yield* refuseWhileSending("invoice", invoice)
    if (invoice.agreementId !== agreement.id) return yield* new InvalidState({ code: "agreement_mismatch", message: "The draft must be linked to this agreement" })
    if (lines.some(line => (line.isDeposit && !input.scheduleAsSale ? "prepayment" : "sale") !== invoice.purpose))
      return yield* new InvalidState({ code: "purpose_mismatch", message: "Service and schedule lines require separate drafts unless the schedule is explicitly invoiced as a sale" })
    if (invoice.items.length + lines.length > 100) return yield* new InvalidState({ code: "too_many_items", message: "An invoice may have at most 100 lines" })
    const startOrder = Math.max(-1, ...invoice.items.map(line => line.sortOrder)) + 1
    const rows = lines.map((line, index) => frozenInvoiceLine(line, startOrder + index, agreement.pricesIncludeTax))
    const saleIds = lines.filter(line => line.isDeposit && input.scheduleAsSale).map(line => line.id)
    const previousChoice = invoice.scheduleSaleChoice as { deliverableIds?: string[] } | null
    const updated = yield* Effect.promise(() => db.invoice.update({ where: { id: invoice.id }, data: {
      editRevision: { increment: 1 }, ...frozenTotals([...invoice.items, ...rows]), items: { create: rows },
      ...(saleIds.length ? { scheduleSaleChoice: { deliverableIds: [...(previousChoice?.deliverableIds ?? []), ...saleIds], actor: actorKey(command.actor), commandId: command.commandId, at: command.now.toISOString() } } : {}),
    }, include }))
    yield* reserveLines(agreement.id, invoice.id, lines)
    command.emit({ aggregateType: "invoice", aggregateId: invoice.id, type: "invoice.draft_updated", payload: { fields: ["deliverables"] } })
    return updated
  }),
})

export const invoiceScheduleAsSale = defineCommand({
  type: "invoice.schedule_as_sale", permission: "invoice:update", outwardFacing: false,
  input: z.strictObject({ id: z.string().min(1), confirmed: z.literal(true), expectedRevision: z.number().int().nonnegative().optional() }),
  summarize: input => `Invoice the payment schedule on ${input.id} as a sale`,
  handle: input => Effect.gen(function* () {
    const db = yield* Db, command = yield* Command
    yield* lockDocument("invoice", input.id)
    const invoice = yield* Effect.promise(() => db.invoice.findFirst({ where: { id: input.id, organizationId: command.organizationId }, include }))
    if (!invoice) return yield* new NotFound({ message: "Invoice not found", entity: "invoice", id: input.id })
    if (invoice.status !== "draft" || invoice.purpose !== "prepayment" || !invoice.agreementId)
      return yield* new InvalidState({ code: "not_prepayment_draft", message: "Only a linked prepayment draft can be invoiced as a sale" })
    if (input.expectedRevision !== undefined && input.expectedRevision !== invoice.editRevision)
      return yield* new InvalidState({ code: "stale_draft", message: "This draft changed since it was loaded. Reload it before saving." })
    yield* refuseWhileSending("invoice", invoice)
    const updated = yield* Effect.promise(() => db.invoice.update({ where: { id: invoice.id }, data: {
      editRevision: { increment: 1 }, purpose: "sale", scheduleSaleChoice: { deliverableIds: invoice.items.flatMap(line => line.deliverableId ? [line.deliverableId] : []), actor: actorKey(command.actor), commandId: command.commandId, at: command.now.toISOString() },
    }, include }))
    command.emit({ aggregateType: "invoice", aggregateId: invoice.id, type: "invoice.draft_updated", payload: { fields: ["purpose", "scheduleSaleChoice"] } })
    return updated
  }),
})
export const invoiceDeliverableCommands = [createInvoiceFromDeliverables, addInvoiceDeliverables, invoiceScheduleAsSale] as const
