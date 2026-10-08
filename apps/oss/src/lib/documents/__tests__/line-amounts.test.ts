import { describe, expect, it } from "vitest"
import { Prisma } from "../../../../generated/prisma/client"
import { priceDocumentV2 } from "../../../domain/documents/pricing"
import { frozenVatRows, frozenVatRowsOrUndefined, vatRowsByRate } from "../../../domain/documents/frozen-vat-groups"
import { lineAmounts, lineColumnKeys, priceBasis, printableVatRows } from "../line-amounts"

const D = Prisma.Decimal
const sum = (values: Array<Prisma.Decimal>) => values.reduce((total, value) => total.plus(value), new D(0))

/** A stored line as the database holds it: priced once, never recomputed. */
function stored(input: {
  items: Array<{ description: string; quantity: string; unitPrice: string; vat?: { treatment: "standard" | "exempt"; rate: string; country?: string | null; reasonCode?: string | null } }>
  pricesIncludeTax: boolean
  currency: string
}) {
  const priced = priceDocumentV2({ items: input.items as never, taxRate: "25", pricesIncludeTax: input.pricesIncludeTax, currency: input.currency })
  return {
    pricesIncludeTax: input.pricesIncludeTax,
    currency: input.currency,
    subtotalNet: new D(priced.subtotalNet),
    totalTax: new D(priced.totalTax),
    totalGross: new D(priced.totalGross),
    items: priced.itemRows.map((row) => ({
      ...row,
      quantity: new D(row.quantity),
      unitPriceNet: new D(row.unitPriceNet),
      unitPriceGross: new D(row.unitPriceGross),
      lineNet: new D(row.lineNet),
      lineTax: new D(row.lineTax),
      lineGross: new D(row.lineGross),
      taxRate: new D(row.taxRate),
    })),
  }
}
const printed = (document: ReturnType<typeof stored>) =>
  document.items.map((line) => lineAmounts(priceBasis(document.pricesIncludeTax), line))

describe("priceBasis", () => {
  it("is gross only when the prices include VAT", () => {
    expect(priceBasis(true)).toBe("gross")
    expect(priceBasis(false)).toBe("net")
    expect(priceBasis(undefined)).toBe("net")
    expect(priceBasis(null)).toBe("net")
  })
})

describe("lineAmounts", () => {
  const line = { unitPriceNet: "40.00", unitPriceGross: "50.00", lineNet: "80.00", lineGross: "100.00" }

  it("selects the stored net values for a net basis", () => {
    expect(lineAmounts("net", line)).toEqual({ unitPrice: "40.00", amount: "80.00" })
  })

  it("selects the stored gross values for a gross basis", () => {
    expect(lineAmounts("gross", line)).toEqual({ unitPrice: "50.00", amount: "100.00" })
  })

  it("returns the very values it was given, without converting them", () => {
    const net = new D("0.10"), gross = new D("0.125")
    const result = lineAmounts("net", { unitPriceNet: net, unitPriceGross: gross, lineNet: net, lineGross: gross })
    expect(result.unitPrice).toBe(net)
    expect(result.amount).toBe(net)
  })
})

describe("lineColumnKeys", () => {
  it("names the basis in the headers", () => {
    expect(lineColumnKeys("net")).toEqual({ unitPrice: "pdf.unitPriceNet", amount: "pdf.amountNet" })
    expect(lineColumnKeys("gross")).toEqual({ unitPrice: "pdf.unitPriceGross", amount: "pdf.amountGross" })
  })

  it("keeps the plain headers when the basis is unknown", () => {
    expect(lineColumnKeys(undefined)).toEqual({ unitPrice: "pdf.unitPrice", amount: "pdf.total" })
  })
})

describe("printableVatRows", () => {
  const row = (ratePercent: string, tax: string) => ({ ratePercent, net: "0.00", tax, gross: "0.00" })

  it("prints nothing for a document with no VAT", () => {
    expect(printableVatRows([row("0", "0.00")])).toEqual([])
    expect(printableVatRows([])).toEqual([])
  })

  it("prints the one rate of a taxed document", () => {
    expect(printableVatRows([row("25", "3625.00")])).toEqual([row("25", "3625.00")])
  })

  it("keeps the zero-rated row when it is mixed with a taxed one", () => {
    const rows = [row("0", "0.00"), row("25", "10.00")]
    expect(printableVatRows(rows)).toEqual(rows)
  })
})

describe("line amounts against stored documents", () => {
  it("adds net lines up to the subtotal, and the Danish example no longer prints gross", () => {
    // 2 x 4.000,00 and 1 x 6.500,00 net at 25 %: the lines were printed as 10.000 and 8.125 (gross).
    const document = stored({ pricesIncludeTax: false, currency: "DKK", items: [
      { description: "Rådgivning", quantity: "2", unitPrice: "4000" },
      { description: "Licens", quantity: "1", unitPrice: "6500" },
    ] })
    const shown = printed(document)
    expect(shown.map((line) => line.unitPrice.toFixed(2))).toEqual(["4000.00", "6500.00"])
    expect(shown.map((line) => line.amount.toFixed(2))).toEqual(["8000.00", "6500.00"])
    expect(sum(shown.map((line) => line.amount)).toFixed(2)).toBe(document.subtotalNet.toFixed(2))
    expect(document.subtotalNet.toFixed(2)).toBe("14500.00")
    expect(document.totalTax.toFixed(2)).toBe("3625.00")
    expect(document.totalGross.toFixed(2)).toBe("18125.00")
  })

  it("adds gross lines up to the total when the prices include VAT", () => {
    const document = stored({ pricesIncludeTax: true, currency: "DKK", items: [
      { description: "A", quantity: "3", unitPrice: "33.33" },
      { description: "B", quantity: "1", unitPrice: "0.05" },
      { description: "C", quantity: "7", unitPrice: "12.49" },
    ] })
    const shown = printed(document)
    expect(sum(shown.map((line) => line.amount)).toFixed(2)).toBe(document.totalGross.toFixed(2))
  })

  it("keeps the line sums exact where float sums drift", () => {
    // 0.1 + 0.2 is 0.30000000000000004 in floats; the stored decimals add up exactly.
    const document = stored({ pricesIncludeTax: false, currency: "USD", items: [
      { description: "A", quantity: "1", unitPrice: "0.10" },
      { description: "B", quantity: "1", unitPrice: "0.20" },
      { description: "C", quantity: "1", unitPrice: "0.30" },
    ] })
    const amounts = printed(document).map((line) => line.amount)
    expect(amounts.map((amount) => amount.toFixed(2))).toEqual(["0.10", "0.20", "0.30"])
    expect(sum(amounts).toFixed(2)).toBe("0.60")
    expect(document.subtotalNet.toFixed(2)).toBe("0.60")
    expect(Number(amounts[0]!.toFixed(2)) + Number(amounts[1]!.toFixed(2))).not.toBe(0.3)
  })

  it("uses the allocated, stored net of a gross-priced line, not a recomputation", () => {
    // 100,00 gross at 25 % is 80,00 net, but three such lines allocate the rounding unevenly.
    const document = stored({ pricesIncludeTax: true, currency: "DKK", items: [
      { description: "A", quantity: "1", unitPrice: "0.99" },
      { description: "B", quantity: "1", unitPrice: "0.99" },
      { description: "C", quantity: "1", unitPrice: "0.99" },
    ] })
    const net = lineAmounts("net", document.items[0]!)
    expect(net.amount).toBe(document.items[0]!.lineNet)
    expect(sum(document.items.map((line) => line.lineNet)).toFixed(2)).toBe(document.subtotalNet.toFixed(2))
    expect(sum(printed(document).map((line) => line.amount)).toFixed(2)).toBe(document.totalGross.toFixed(2))
  })

  it("handles currencies without minor units", () => {
    const document = stored({ pricesIncludeTax: false, currency: "JPY", items: [
      { description: "A", quantity: "3", unitPrice: "105" },
      { description: "B", quantity: "1", unitPrice: "999" },
    ] })
    const shown = printed(document)
    expect(shown.map((line) => line.amount.toFixed(0))).toEqual(["315", "999"])
    expect(sum(shown.map((line) => line.amount)).toFixed(0)).toBe(document.subtotalNet.toFixed(0))
  })

  it("lets each line follow its own rate while the lines still add up", () => {
    const document = stored({ pricesIncludeTax: false, currency: "DKK", items: [
      { description: "Standard", quantity: "1", unitPrice: "1000" },
      { description: "Export", quantity: "1", unitPrice: "500", vat: { treatment: "exempt", rate: "0", reasonCode: "other" } },
      { description: "Reduced", quantity: "2", unitPrice: "100.50", vat: { treatment: "standard", rate: "0.05" } },
    ] })
    const shown = printed(document)
    expect(shown.map((line) => line.amount.toFixed(2))).toEqual(["1000.00", "500.00", "201.00"])
    expect(sum(shown.map((line) => line.amount)).toFixed(2)).toBe(document.subtotalNet.toFixed(2))
  })
})

describe("frozenVatRows", () => {
  it("returns one row per rate, sorted, from the stored lines", () => {
    const document = stored({ pricesIncludeTax: false, currency: "DKK", items: [
      { description: "Standard", quantity: "1", unitPrice: "1000" },
      { description: "Reduced", quantity: "2", unitPrice: "100.50", vat: { treatment: "standard", rate: "0.05" } },
      { description: "Standard again", quantity: "1", unitPrice: "200" },
      { description: "Zero", quantity: "1", unitPrice: "500", vat: { treatment: "exempt", rate: "0", reasonCode: "other" } },
    ] })
    const rows = frozenVatRows({ ...document, items: document.items.map((line) => ({ ...line, vatCountry: line.vatCountry ?? null, vatReasonCode: line.vatReasonCode ?? null })) })
    expect(rows).toEqual([
      { ratePercent: "0", net: "500.00", tax: "0.00", gross: "500.00" },
      { ratePercent: "5", net: "201.00", tax: "10.05", gross: "211.05" },
      { ratePercent: "25", net: "1200.00", tax: "300.00", gross: "1500.00" },
    ])
    expect(sum(rows.map((row) => new D(row.tax))).toFixed(2)).toBe(document.totalTax.toFixed(2))
    expect(sum(rows.map((row) => new D(row.net))).toFixed(2)).toBe(document.subtotalNet.toFixed(2))
  })

  it("merges groups that differ only in treatment into the rate they share", () => {
    const rows = vatRowsByRate([
      { rate: "0", net: "100.00", tax: "0.00", gross: "100.00" },
      { rate: "0", net: "50.00", tax: "0.00", gross: "50.00" },
      { rate: "0.25", net: "80.00", tax: "20.00", gross: "100.00" },
    ], "DKK")
    expect(rows).toEqual([
      { ratePercent: "0", net: "150.00", tax: "0.00", gross: "150.00" },
      { ratePercent: "25", net: "80.00", tax: "20.00", gross: "100.00" },
    ])
  })

  it("writes whole currency units for a currency without minor units", () => {
    const rows = vatRowsByRate([
      { rate: "0.25", net: "315", tax: "79", gross: "394" },
      { rate: "0.25", net: "999", tax: "250", gross: "1249" },
    ], "JPY")
    expect(rows).toEqual([{ ratePercent: "25", net: "1314", tax: "329", gross: "1643" }])
  })
})

describe("frozenVatRowsOrUndefined", () => {
  const line = { vatTreatment: "exempt", vatReasonCode: null, vatCountry: null, vatRateInput: "0", taxRate: "0", lineNet: "10.00", lineTax: "0.00", lineGross: "10.00" }

  it("has no rows for a draft whose VAT classification is unfinished, instead of throwing", () => {
    expect(() => frozenVatRows({ currency: "DKK", items: [line] })).toThrow()
    expect(frozenVatRowsOrUndefined({ currency: "DKK", items: [line] })).toBeUndefined()
  })

  it("has no rows for a document without lines", () => {
    expect(frozenVatRowsOrUndefined({ currency: "DKK", items: [] })).toBeUndefined()
  })

  it("has the rows of a finished one", () => {
    expect(frozenVatRowsOrUndefined({ currency: "DKK", items: [{ ...line, vatReasonCode: "other" }] }))
      .toEqual([{ ratePercent: "0", net: "10.00", tax: "0.00", gross: "10.00" }])
  })
})

