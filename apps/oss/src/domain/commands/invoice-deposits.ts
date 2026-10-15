import { Effect } from "effect"
import { invoiceDeductDepositsInputSchema } from "@quits/contracts/invoices"
import { Prisma, type Invoice, type InvoiceItem } from "../../../generated/prisma/client"
import { creditComponents, vatGroupKey, percentageToFraction } from "@quits/shared/pricing"
import { frozenTotals } from "../agreements/billing"
import { requireDepositsEnabled } from "../agreements/deposit-capability"
import { frozenVatGroups } from "../documents/frozen-vat-groups"
import { documentFractionDigits } from "../documents/pricing"
import { lockDocument } from "../documents/locks"
import { refuseWhileSending } from "../documents/document-delivery"
import { defineCommand } from "../command"
import { InvalidState, NotFound } from "../errors"
import { Command, Db } from "../services"
import type { InvoiceIssued } from "../events/money"

export const isAconto = (line: { sourceKind?: string | null }) => line.sourceKind === "aconto"
const include = { items: { orderBy: { sortOrder: "asc" as const } } }
type DeductionRow = Prisma.InvoiceItemCreateManyInvoiceInput & Pick<InvoiceItem, "lineNet" | "lineTax" | "lineGross" | "taxRate" | "vatTreatment" | "vatRateInput" | "vatCountry" | "vatReasonCode">
const key = (line: InvoiceItem) => vatGroupKey({ treatment: line.vatTreatment, country: line.vatCountry, reasonCode: line.vatReasonCode, rate: line.vatRateInput ?? percentageToFraction(line.taxRate.toString()) })
/** The agreement lock serializes reservations, issuance, deletion and source credit notes. */
export const applyDepositDeductions = (invoice: Invoice & { items: InvoiceItem[] }, amountGross?: string) => Effect.gen(function* () {
  const db = yield* Db, command = yield* Command
  if (invoice.status !== "draft") return yield* new InvalidState({ code: "not_draft", message: "Only draft invoices can change deductions" })
  yield* refuseWhileSending("invoice", invoice)
  if (amountGross !== undefined && !new Prisma.Decimal(amountGross).toDecimalPlaces(documentFractionDigits(invoice.currency)).eq(amountGross))
    return yield* new InvalidState({ code: "aconto_precision", message: "The deduction must use the invoice currency's minor units" })
  if (!invoice.agreementId || invoice.purpose !== "sale" || invoice.scheduleSaleChoice)
    return yield* new InvalidState({ code: "aconto_final_required", message: "Deductions require a final sale invoice linked to an agreement" })
  const ordinary = invoice.items.filter(line => !isAconto(line))
  const sources = yield* Effect.promise(() => db.invoice.findMany({ where: { organizationId: command.organizationId, agreementId: invoice.agreementId, id: { not: invoice.id }, status: "sent", disputed: false }, include: { ...include, creditNotes: { where: { status: "issued" }, select: { id: true } } }, orderBy: [{ issueDate: "asc" }, { id: "asc" }] }))
  yield* Effect.promise(() => db.invoiceItem.deleteMany({ where: { invoiceId: invoice.id, sourceKind: "aconto" } }))
  const rows: DeductionRow[] = []
  let remaining = new Prisma.Decimal(amountGross ?? frozenTotals(ordinary).totalGross)
  for (const source of sources) {
    const choice = source.scheduleSaleChoice as { deliverableIds?: string[] } | null
    const snapshot = source.issuanceSnapshot as InvoiceIssued | null
    if (!choice || !snapshot || source.creditNotes.length || source.currency !== invoice.currency || source.contactId !== invoice.contactId) continue
    for (const line of source.items.filter(item => item.deliverableId && choice.deliverableIds?.includes(item.deliverableId))) {
      if (remaining.isZero() || ordinary.length + rows.length >= 100) break
      const frozen = snapshot.lines.find(item => item.lineId === line.id)
      if (!frozen || !line.lineGross.gt(0)) continue
      const prior = yield* Effect.promise(() => db.invoiceItem.findMany({ where: { sourceKind: "aconto", sourceId: line.id } }))
      const before = prior.reduce((sum, item) => sum.minus(item.lineGross), new Prisma.Decimal(0))
      const available = line.lineGross.minus(before)
      const group = frozenVatGroups({ ...invoice, items: [...ordinary, ...rows] }).find(group => group.key === key(line))
      if (!group || available.lte(0)) continue
      const gross = Prisma.Decimal.min(remaining, available, group.gross)
      if (gross.lte(0)) continue
      yield* requireDepositsEnabled([{ isDeposit: true }])
      // Allocate the actual remaining frozen components so removing an earlier draft cannot
      // strand VAT in a later reservation. Issuance values the final frozen groups separately.
      const residual = (field: "net" | "tax" | "gross", stored: "lineNet" | "lineTax" | "lineGross") => prior.reduce((sum, item) => sum.plus(item[stored]), new Prisma.Decimal(frozen[field])).toFixed(group.exponent)
      const net = residual("net", "lineNet"), tax = residual("tax", "lineTax"), left = residual("gross", "lineGross")
      const rounding = new Prisma.Decimal(left).minus(net).minus(tax).toFixed(group.exponent)
      const components = yield* Effect.try({ try: () => creditComponents({ group: { ...group, net, tax, gross: left,
        payableRounding: rounding, netBase: net, taxBase: tax, grossBase: left,
        payableRoundingBase: rounding, baseExponent: group.exponent }, cumulativeBefore: "0", creditedGross: gross.toFixed(group.exponent) }),
        catch: () => new InvalidState({ code: "aconto_precision", message: "The deduction must use the invoice currency's minor units" }) })
      if (new Prisma.Decimal(group.net).lt(components.net) || new Prisma.Decimal(group.tax).lt(components.tax)) {
        if (amountGross === undefined) continue
        return yield* new InvalidState({ code: "aconto_vat_exceeds_final", message: "The deduction exceeds the final invoice's matching VAT components" })
      }
      rows.push({ sourceKind: "aconto", sourceId: line.id, sourceRevision: source.id,
        allocationGeneration: Math.max(-1, ...prior.map(item => item.allocationGeneration)) + 1,
        description: `${source.number}: ${line.description}`, quantity: "-1", quantityInput: "-1",
        unitPriceNet: components.net, unitPriceGross: components.gross, unitPriceInput: invoice.pricesIncludeTax ? components.gross : components.net,
        lineNet: new Prisma.Decimal(components.net).negated(), lineTax: new Prisma.Decimal(components.tax).negated(), lineGross: gross.negated(),
        taxRate: line.taxRate, taxCategory: line.taxCategory, vatTreatment: line.vatTreatment, vatRateInput: line.vatRateInput,
        vatCountry: line.vatCountry, vatReasonCode: line.vatReasonCode, sortOrder: Math.max(-1, ...invoice.items.map(item => item.sortOrder)) + rows.length + 1 })
      remaining = remaining.minus(gross)
    }
  }
  if (amountGross !== undefined && remaining.gt(0)) return yield* new InvalidState({ code: "aconto_insufficient", message: "The requested deduction exceeds the available aconto or matching final invoice amount" })
  if (!rows.length && !invoice.items.some(isAconto)) return invoice
  const updated = yield* Effect.promise(() => db.invoice.update({ where: { id: invoice.id }, data: {
    editRevision: { increment: 1 }, ...frozenTotals([...ordinary, ...rows]), items: { create: rows },
  }, include }))
  command.emit({ aggregateType: "invoice", aggregateId: invoice.id, type: "invoice.draft_updated", payload: { fields: ["deductions"] } })
  return updated
})

export const deductInvoiceDeposits = defineCommand({
  type: "invoice.deduct_deposits", permission: "invoice:update", outwardFacing: false,
  input: invoiceDeductDepositsInputSchema,
  summarize: input => `Update aconto deductions on invoice ${input.id}`,
  handle: input => Effect.gen(function* () {
    const db = yield* Db, { organizationId } = yield* Command
    yield* lockDocument("invoice", input.id)
    const invoice = yield* Effect.promise(() => db.invoice.findFirst({ where: { id: input.id, organizationId }, include }))
    if (!invoice) return yield* new NotFound({ message: "Invoice not found", entity: "invoice", id: input.id })
    if (input.expectedRevision !== undefined && input.expectedRevision !== invoice.editRevision)
      return yield* new InvalidState({ code: "stale_draft", message: "Reload this draft before changing deductions" })
    return yield* applyDepositDeductions(invoice, input.amountGross)
  }),
})
