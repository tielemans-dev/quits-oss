import { issuedNumber } from "../documents/numbering"
import { assertStoredDocumentEquation, percentageToFraction } from "@quits/shared/pricing"
import { z } from "zod"
import { Effect } from "effect"
import { invoiceSendInputSchema } from "@quits/contracts/invoices"
import { parseBuyerSnapshot, parseSellerSnapshot } from "@quits/contracts/documents"
import { defineCommand } from "../command"
import { Db, Command } from "../services"
import { InvalidState, NotFound } from "../errors"
import { lockDocument } from "../documents/locks"
import { invoiceMoneySnapshot, jsonSnapshot } from "../documents/money-snapshot"

export const recordBaseValuationInputSchema = invoiceSendInputSchema.pick({ id: true, exchangeRate: true, rateDate: true }).extend({ evidenceNote: z.string().trim().min(1).max(5000) })

export const recordBaseValuation = defineCommand({
  type: "invoice.record_base_valuation", permission: "invoice:update", outwardFacing: false,
  input: recordBaseValuationInputSchema,
  summarize: input => `Record reviewed historical valuation for invoice ${input.id}`,
  handle: input => Effect.gen(function* () {
    const db = yield* Db
    const command = yield* Command
    if (command.actor.kind !== "user") return yield* new InvalidState({ code: "human_review_required", message: "A human must review the historical rate" })
    yield* lockDocument("invoice", input.id)
    const invoice = yield* Effect.promise(() => db.invoice.findFirst({ where: { id: input.id, organizationId: command.organizationId }, include: { items: { orderBy: { sortOrder: "asc" } } } }))
    if (!invoice) return yield* new NotFound({ entity: "invoice", id: input.id, message: "Invoice not found" })
    if (invoice.status === "draft") return yield* new InvalidState({ code: "invoice_not_issued", message: "Only historical issued documents can receive a reviewed valuation" })
    if ((invoice.valuation as { rateSource?: string } | null)?.rateSource && (invoice.valuation as { rateSource: string }).rateSource !== "unknown") return yield* new InvalidState({ code: "valuation_already_recorded", message: "The frozen valuation cannot change" })
    const settings = yield* Effect.promise(() => db.orgSettings.findUniqueOrThrow({ where: { organizationId: command.organizationId } }))
    const snapshot = yield* Effect.try({ try: () => {
      assertStoredDocumentEquation({ currency: invoice.currency, pricesIncludeTax: invoice.pricesIncludeTax, net: invoice.subtotalNet.toString(), tax: invoice.totalTax.toString(), gross: invoice.totalGross.toString(), lines: invoice.items.map(line => ({ vat: { treatment: line.vatTreatment, rate: line.vatRateInput ?? percentageToFraction(line.taxRate.toString()), country: line.vatCountry, reasonCode: line.vatReasonCode }, net: line.lineNet.toString(), tax: line.lineTax.toString(), gross: line.lineGross.toString() })) })
      return invoiceMoneySnapshot(invoice, { ...input, number: issuedNumber(invoice), baseCurrency: settings.baseCurrency, issuedAt: invoice.issueDate, seller: parseSellerSnapshot(invoice.sellerSnapshot) ?? {}, buyer: parseBuyerSnapshot(invoice.buyerSnapshot) ?? {} })
    }, catch: error => error instanceof InvalidState ? error : new InvalidState({ code: "historical_groups_unavailable", message: "Historical VAT groups need review before valuation can be recorded" }) })
    const payload = { documentId: invoice.id, number: invoice.number, valuation: snapshot.valuation, vatGroups: snapshot.vatGroups, reviewedByUserId: command.actor.userId, evidenceNote: input.evidenceNote, occurredAt: command.now.toISOString() }
    command.emit({ aggregateType: "invoice", aggregateId: invoice.id, type: "invoice.base_valuation_recorded", payload })
    return yield* Effect.promise(() => db.invoice.update({ where: { id: invoice.id }, data: { valuation: jsonSnapshot(snapshot.valuation), issuanceSnapshot: jsonSnapshot(snapshot) } }))
  }),
})
