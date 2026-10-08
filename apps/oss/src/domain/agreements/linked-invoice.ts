import { toNullableJsonInput } from "../../lib/prisma-json"
import { Effect } from "effect"
import { Prisma, type Invoice, type InvoiceItem } from "../../../generated/prisma/client"
import type { InvoiceUpdateDraftInput, DocumentLineInput } from "@quits/contracts/invoices"
import { documentVat, percentageToFraction } from "@quits/shared/pricing"
import { priceCurrentDraft } from "../documents/pricing"
import { InvalidState } from "../errors"
import { Command, Db } from "../services"
import { frozenTotals, releaseLines } from "./billing"
import { lockedAgreement } from "./issuance"

function unchanged(line: InvoiceItem, input: NonNullable<InvoiceUpdateDraftInput["items"]>[number]) {
  const equal = (a: string | number, b: string | number) => new Prisma.Decimal(String(a)).equals(String(b))
  const vat = input.vat ? documentVat(input, line.taxRate.toString()) : null
  return input.description === line.description && equal(input.quantity, line.quantityInput ?? line.quantity.toString()) &&
    equal(input.unitPrice, line.unitPriceInput ?? line.unitPriceNet.toString()) &&
    (!vat || (vat.treatment === line.vatTreatment && equal(vat.rate, line.vatRateInput ?? percentageToFraction(line.taxRate.toString())) &&
      vat.country === line.vatCountry && vat.reasonCode === line.vatReasonCode)) &&
    (!input.deliverableId || input.deliverableId === line.deliverableId) && (!input.id || input.id === line.id)
}
/** Linked rows retain their identity and frozen amounts, even on notes-only edits. */
export const updateLinkedInvoice = (invoice: Invoice & { items: InvoiceItem[] }, input: InvoiceUpdateDraftInput) => Effect.gen(function* () {
  const db = yield* Db, command = yield* Command
  const agreement = yield* lockedAgreement(invoice.agreementId!)
  if ((input.contactId !== undefined && input.contactId !== invoice.contactId) ||
    (input.currency !== undefined && input.currency !== invoice.currency) ||
    (input.taxRate !== undefined && !new Prisma.Decimal(agreement.taxRateInput ?? agreement.taxRate.toString()).equals(String(input.taxRate))))
    return yield* new InvalidState({ code: "linked_invoice_context_immutable", message: "A linked invoice keeps the agreement's contact, currency and frozen VAT context" })
  const kept = new Set<string>(), unlinked: DocumentLineInput[] = []
  if (input.items) {
    for (const item of input.items) {
      const linked = invoice.items.find(line => line.deliverableId && (line.id === item.id || line.deliverableId === item.deliverableId))
      if (linked) {
        if (kept.has(linked.id) || !unchanged(linked, item))
          return yield* new InvalidState({ code: "linked_item_immutable", message: "Linked invoice lines must keep their identity and commercial values" })
        kept.add(linked.id)
        if (item.key !== undefined) yield* Effect.promise(() => db.invoiceItem.update({ where: { id: linked.id }, data: { clientKey: item.key } }))
      } else if (item.deliverableId || (item.id && !invoice.items.some(line => line.id === item.id))) {
        return yield* new InvalidState({ code: "invalid_linked_item", message: "Use invoice.addDeliverables to reserve a deliverable" })
      } else unlinked.push({ ...item, key: item.key ?? invoice.items.find(line => line.id === item.id)?.clientKey ?? undefined })
    }
  } else invoice.items.filter(line => line.deliverableId).forEach(line => kept.add(line.id))
  const removed = invoice.items.filter(line => line.deliverableId && !kept.has(line.id))
  let totals = frozenTotals(invoice.items)
  if (input.items) {
    yield* releaseLines(agreement.id, invoice.id, removed)
    yield* Effect.promise(() => db.invoiceItem.deleteMany({ where: { invoiceId: invoice.id, id: { notIn: [...kept] } } }))
    // The convenience rate comes from the accepted offer, never today's org settings.
    const priced = yield* priceCurrentDraft({ items: unlinked.map(item => ({ ...item, vat: undefined })), taxRate: agreement.taxRateInput ?? agreement.taxRate.toString(), currency: agreement.currency, pricesIncludeTax: agreement.pricesIncludeTax })
    if (priced.itemRows.length) yield* Effect.promise(() => db.invoiceItem.createMany({ data: priced.itemRows.map((row, index) => ({ ...row, invoiceId: invoice.id, sortOrder: invoice.items.length + index })) }))
    totals = frozenTotals([...invoice.items.filter(line => kept.has(line.id)), ...priced.itemRows])
  }
  const updated = yield* Effect.promise(() => db.invoice.update({ where: { id: invoice.id }, data: {
    editRevision: { increment: 1 }, ...totals, ...(input.supplyDate ? { supplyDate: new Date(input.supplyDate) } : {}), ...(input.vatEvidence !== undefined ? { vatEvidence: toNullableJsonInput(input.vatEvidence) } : {}), ...(input.dueDate ? { dueDate: new Date(input.dueDate) } : {}), ...(input.notes !== undefined ? { notes: input.notes } : {}),
  }, include: { contact: true, items: { orderBy: { sortOrder: "asc" } } } }))
  command.emit({ aggregateType: "invoice", aggregateId: invoice.id, type: "invoice.draft_updated", payload: { fields: Object.keys(input).filter(key => key !== "id") } })
  return updated
})
