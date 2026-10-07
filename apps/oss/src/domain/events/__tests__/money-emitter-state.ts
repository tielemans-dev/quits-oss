import { Prisma } from "../../../../generated/prisma/client"
import { invoiceMoneySnapshot, creditMoneySnapshot } from "../../documents/money-snapshot"
import { creditAvailabilityFor } from "../../documents/credit-pricing"
import { buildCreditLines } from "../../../lib/credit-notes/calculation"

/** Synthetic writer state, computed without reading the expected fixture payloads. */
export function moneyEmitterState(kind: string) {
  const issuedAt = new Date("2026-10-07T12:00:00.000Z")
  const decimal = (value: string) => new Prisma.Decimal(value)
  const invoice = {
    id: "document-1", number: "DOC-0001", purpose: "sale", currency: "EUR", timezone: "UTC",
    supplyDate: issuedAt, dueDate: new Date("2026-11-07"), calculationVersion: "v2", pricesIncludeTax: false,
    agreementId: null, quoteId: null, recurringInvoiceId: null, creditNotes: [],
    subtotalNet: decimal("0.04"), totalTax: decimal("0.01"), totalGross: decimal("0.05"),
    items: [{ id: "line-1", description: "Work", deliverableId: null, quantity: decimal("1"), quantityInput: "1", unitPriceInput: "0.04",
      unitPriceNet: decimal("0.04"), unitPriceGross: decimal("0.05"), lineNet: decimal("0.04"), lineTax: decimal("0.01"), lineGross: decimal("0.05"),
      taxRate: decimal("25"), taxCategory: "standard", taxCode: null, vatTreatment: "standard", vatRateInput: "0.25", vatCountry: "DK", vatReasonCode: null }],
  }
  const seller = { companyName: "Seller", taxIds: [{ scheme: "VAT", value: "DK12345678" }] }
  const buyer = { name: "Buyer", taxIds: [{ scheme: "VAT", value: "DE123456789" }] }
  const money = invoiceMoneySnapshot(invoice as never, { issuedAt, baseCurrency: "DKK", exchangeRate: "0.8", rateDate: "2026-10-07", seller, buyer })
  if (kind !== "creditNote") return money
  const valuedInvoice = { ...invoice, issuanceSnapshot: money }
  const built = buildCreditLines({ availability: creditAvailabilityFor(valuedInvoice), selection: { mode: "full" }, taxRate: 25, amountDescription: "Correction" })
  if (!built.ok) throw new Error(built.message)
  return creditMoneySnapshot(valuedInvoice as never, { id: "document-1", number: "DOC-0001", issuedAt, baseCurrency: "DKK", reason: "Correction", mode: "full", built, hasPayments: false, paid: "0", priorCredits: "0", seller, buyer })
}
