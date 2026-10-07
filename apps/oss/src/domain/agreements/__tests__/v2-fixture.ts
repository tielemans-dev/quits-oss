import { Prisma, type Agreement, type Deliverable } from "../../../../generated/prisma/client"
import { priceAgreementV2 } from "../pricing"
export function v2Fixture() {
  const input = { currency: "DKK", pricesIncludeTax: true, taxRate: "25",
    deliverables: [
      { title: "Service A", description: "Work A", quantity: "1.000001", unitPrice: "0.0100" },
      { title: "Service B", description: "Work B", quantity: "1", unitPrice: "0.01" },
      { title: "Deposit", description: "Payment on acceptance", quantity: "1", unitPrice: "20", isDeposit: true },
    ] }
  const priced = priceAgreementV2(input)
  const money = (value: string | number) => new Prisma.Decimal(value)
  return {
    offerFormatVersion: 2, calculationVersion: "v2", title: "Ledger-ready offer", summary: null,
    termsMarkdown: "Service price {{agreement.total}}.", validUntil: new Date("2099-01-01"),
    timezone: "Europe/Copenhagen", currency: "DKK", countryCode: "DK", locale: "da-DK", taxRegime: "eu_vat",
    taxRate: money("25"), pricesIncludeTax: true, dueInDays: 30, billingTrigger: "on_acceptance",
    subtotalNet: money(priced.subtotalNet), totalTax: money(priced.totalTax), totalGross: money(priced.totalGross),
    sellerSnapshot: null, buyerSnapshot: null,
    deliverables: priced.deliverableRows.map(row => ({ ...row, id: `line-${row.sortOrder}`, taxCode: null,
      quantity: money(row.quantity), unitPriceNet: money(row.unitPriceNet), unitPriceGross: money(row.unitPriceGross),
      lineNet: money(row.lineNet), lineTax: money(row.lineTax), lineGross: money(row.lineGross), taxRate: money(row.taxRate),
    } as unknown as Deliverable)),
  } as unknown as Agreement & { deliverables: Deliverable[] }
}
