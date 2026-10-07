import { Effect } from "effect"
import { Prisma, type Deliverable, type InvoiceItem } from "../../../generated/prisma/client"
import { percentageToFraction } from "@quits/shared/pricing"
import { InvalidState } from "../errors"
import { Command, Db } from "../services"
import { lockedAgreement } from "./issuance"

import { isBillable } from "./billing-rules"
export { isBillable } from "./billing-rules"
export const billableSelection = (agreementId: string, ids: string[]) => Effect.gen(function* () {
  if (new Set(ids).size !== ids.length) return yield* new InvalidState({ code: "duplicate_deliverables", message: "Deliverable ids must be unique" })
  const agreement = yield* lockedAgreement(agreementId)
  const lines = ids.map(id => agreement.deliverables.find(line => line.id === id))
  if (lines.some(line => !line || !isBillable(agreement, line)))
    return yield* new InvalidState({ code: "deliverable_not_billable", message: "Every selected deliverable must belong to this agreement and be billable" })
  return { agreement, lines: lines as Deliverable[] }
})

/** Copy commercial values, including v2 original inputs and allocated VAT, without repricing. */
export function frozenInvoiceLine(line: Deliverable, sortOrder: number, pricesIncludeTax: boolean) {
  return {
    deliverableId: line.id, description: line.description || line.title,
    quantity: line.quantity, unitPriceNet: line.unitPriceNet, unitPriceGross: line.unitPriceGross,
    lineNet: line.lineNet, lineTax: line.lineTax, lineGross: line.lineGross, taxRate: line.taxRate,
    taxCategory: line.taxCategory, taxCode: line.taxCode, sortOrder,
    quantityInput: line.quantityInput ?? line.quantity.toString(),
    unitPriceInput: line.unitPriceInput ?? (pricesIncludeTax ? line.unitPriceGross : line.unitPriceNet).toString(),
    inputPrecision: line.inputPrecision ?? "backfilled",
    vatTreatment: line.vatTreatment === "standard" && line.taxRate.isZero() ? "out_of_scope" : line.vatTreatment,
    vatRateInput: line.vatRateInput ?? percentageToFraction(line.taxRate.toString()),
    vatCountry: line.vatCountry, vatReasonCode: line.vatReasonCode,
  }
}
export function frozenTotals(lines: Array<{ lineNet: Prisma.Decimal | string; lineTax: Prisma.Decimal | string; lineGross: Prisma.Decimal | string }>) {
  const sum = (field: "lineNet" | "lineTax" | "lineGross") => lines.reduce((value, line) => value.plus(line[field]), new Prisma.Decimal(0))
  return { subtotalNet: sum("lineNet"), totalTax: sum("lineTax"), totalGross: sum("lineGross") }
}
export const reserveLines = (agreementId: string, invoiceId: string, lines: Deliverable[]) => Effect.gen(function* () {
  const db = yield* Db, command = yield* Command
  for (const line of lines) {
    const updated = yield* Effect.promise(() => db.deliverable.updateMany({ where: { id: line.id, agreementId, billingStatus: "unbilled" }, data: { billingStatus: "reserved" } }))
    if (updated.count !== 1) return yield* new InvalidState({ code: "deliverable_not_billable", message: "Deliverable was already reserved" })
    command.emit({ aggregateType: "agreement", aggregateId: agreementId, type: "deliverable.reserved", payload: { deliverableId: line.id, invoiceId } })
  }
})
export const releaseLines = (agreementId: string, invoiceId: string, lines: Pick<InvoiceItem, "deliverableId">[]) => Effect.gen(function* () {
  const db = yield* Db, command = yield* Command
  for (const line of lines) {
    if (!line.deliverableId) continue
    const deliverableId = line.deliverableId
    const released = yield* Effect.promise(() => db.deliverable.updateMany({ where: { id: deliverableId, agreementId, billingStatus: "reserved" }, data: { billingStatus: "unbilled" } }))
    if (released.count !== 1) return yield* new InvalidState({ code: "reservation_mismatch", message: "The linked deliverable is not reserved" })
    command.emit({ aggregateType: "agreement", aggregateId: agreementId, type: "deliverable.released", payload: { deliverableId: line.deliverableId, invoiceId } })
  }
})
