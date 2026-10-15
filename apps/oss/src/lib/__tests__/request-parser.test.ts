import { describe, expect, it } from "vitest"
import { previewDraft } from "@quits/shared/pricing"
import { normalizeInvoiceQuantity } from "../invoice-quantity"
import { parseRequest, type RequestContext } from "../request-parser"

const context: RequestContext = {
  customers: [{ id: "n", name: "Nordlys ApS", cvr: "DK12345678" }],
  catalogItems: [{ id: "consulting", name: "Konsulent", description: "Konsulentarbejde", defaultUnitPrice: 850 }],
}
const parse = (input: string, ctx = context) => parseRequest(input, ctx)

describe("request parser", () => {
  it.each(["vis forfaldne", "hvem har ikke betalt?", "VIS FORFALDNE FAKTURAER"])("recognizes overdue: %s", input => {
    expect(parse(input)).toEqual({ intent: "overdue", items: [], confidence: 1, remainder: "" })
  })
  it("preserves unsupported overdue filters", () => {
    expect(parse("vis forfaldne fra sidste måned")?.remainder).toBe("fra sidste måned")
  })
  it("parses the invoice phrase and a partial customer name", () => {
    expect(parse("faktura til Nordlys 12 timer à 850 kr.")).toEqual({
      intent: "invoice", customer: { status: "matched", query: "Nordlys", candidates: context.customers },
      items: [{ description: "", quantity: "12", unit: "hour", unitPrice: "850" }], confidence: 1, remainder: "",
    })
  })
  it("matches catalogue items, using the default price unless one is explicit", () => {
    expect(parse("fakturer Nordlys ApS 10t konsulent")?.items).toEqual([
      { description: "Konsulentarbejde", quantity: "10", unit: "hour", unitPrice: "850", catalogItemId: "consulting" },
    ])
    expect(parse("fakturer Nordlys 10t à 900 kr. konsulent")?.items[0]?.unitPrice).toBe("900")
  })
  it.each([
    ["12 timer à 1.250,50 kr.", "12", "1250.50"], ["10t a 850 kr.", "10", "850"],
    ["2 x 1.250,50", "2", "1250.50"], ["1,5 timer à 850", "1.5", "850"],
    ["3 stk. x 0 kr.", "3", "0"], ["1.000 timer a 1.000.000,00 kr.", "1000", "1000000.00"],
  ])("parses Danish numbers: %s", (text, quantity, unitPrice) => {
    expect(parse(`fakturer Nordlys ${text}`)?.items[0]).toMatchObject({ quantity, unitPrice })
  })
  it("parses an amount without inventing a quantity", () => {
    expect(parse("fakturer Nordlys 850 kr.")?.items).toEqual([{ description: "", unitPrice: "850" }])
  })
  it.each(["12345678", "CVR: DK12345678", "cvr 12345678"])("matches CVR: %s", cvr => {
    expect(parse(`fakturer ${cvr} 10t konsulent`)?.customer?.status).toBe("matched")
  })
  it("prefers an exact name and accepts a single typo in a longer name", () => {
    expect(parse("fakturer nordlys aps 10t")?.customer?.status).toBe("matched")
    expect(parse("fakturer Nordls 10t")?.customer?.status).toBe("matched")
    const customers = [...context.customers, { id: "other", name: "Nordlys ApS Design" }]
    expect(parse("fakturer Nordlys ApS 10t", { ...context, customers })?.customer?.candidates).toEqual(context.customers)
  })
  it("returns ambiguous customers in stable order, including fuzzy matches", () => {
    const customers = [...context.customers, { id: "a", name: "Nordlys Studio" }]
    for (const query of ["Nordlys", "Nordls"]) {
      const draft = parse(`fakturer ${query} 10t`, { ...context, customers })
      expect(draft?.customer?.status).toBe("ambiguous")
      expect(draft?.customer?.candidates.map(c => c.id)).toEqual(["a", "n"])
      expect(parse(`fakturer ${query} 10t`, { ...context, customers: [...customers].reverse() })).toEqual(draft)
    }
  })
  it("keeps duplicate CVRs ambiguous and unknown CVRs unknown", () => {
    const customers = [...context.customers, { id: "duplicate", name: "Other", cvr: "12345678" }]
    expect(parse("fakturer CVR 12345678 10t", { ...context, customers })?.customer?.status).toBe("ambiguous")
    expect(parse("fakturer CVR 87654321 10t")?.customer?.status).toBe("unknown")
  })
  it("reports unknown and missing customers", () => {
    expect(parse("fakturer Ukendt Firma 12 timer")?.customer).toEqual({ status: "unknown", query: "Ukendt Firma", candidates: [] })
    expect(parse("fakturer 12 timer")?.customer?.status).toBe("missing")
    expect(parse("fakturer Nordlys 12 timer", { ...context, customers: [] })?.customer?.status).toBe("unknown")
  })
  it("leaves unmatched items and unsupported fields for the caller", () => {
    const draft = parse("fakturer Nordlys 12 timer à 850 kr. ukendt ydelse i morgen")
    expect(draft?.remainder).toBe("ukendt ydelse i morgen")
    expect(draft?.confidence).toBeLessThan(1)
    expect(draft).not.toHaveProperty("dueDate")
    expect(draft).not.toHaveProperty("total")
  })
  it("does not choose between duplicate catalogue entries", () => {
    const catalogItems = [...context.catalogItems, { ...context.catalogItems[0]!, id: "duplicate" }]
    expect(parse("fakturer Nordlys 10t konsulent", { ...context, catalogItems })?.remainder).toBe("konsulent")
  })
  it("does not borrow a later line's price", () => {
    const draft = parse("fakturer Nordlys 10t konsulent + 2t à 900 kr.")
    expect(draft?.items).toEqual([{ description: "", quantity: "10", unit: "hour" }])
    expect(draft?.remainder).toBe("konsulent + 2t à 900 kr.")
  })
  it.each(["", "Nordlys", "find faktura til Nordlys", "vis forfaldnes", "faktureringsadresse", "lav en kaffe"])("leaves ordinary search unchanged: %s", input => {
    expect(parse(input)).toBeNull()
  })
  it.each(["-2 timer", "1,2345678 timer", "1.25 kr.", "1e3 kr."])("preserves unsupported numbers: %s", text => {
    const draft = parse(`fakturer Nordlys ${text}`)
    expect(draft?.items).toEqual([])
    expect(draft?.remainder).toBe(text)
  })
  it.each([false, true])("matches invoice form line amounts, tax inclusive=%s", pricesIncludeTax => {
    const draft = parse("fakturer Nordlys 1,5 timer à 1.250,50 kr. konsulent")!
    const options = { currency: "DKK", taxRate: "25", pricesIncludeTax }
    const parsed = previewDraft({ ...options, items: draft.items.map(item => ({ ...item, quantity: item.quantity!, unitPrice: item.unitPrice! })) })
    const form = previewDraft({ ...options, items: [normalizeInvoiceQuantity({ description: "Konsulentarbejde", quantity: "1,5", unitPrice: "1250.50" }, "da-DK")] })
    expect(parsed.result).not.toBeNull()
    expect(parsed).toEqual(form)
    expect(parsed.result?.gross).toBe(pricesIncludeTax ? "1875.75" : "2344.69")
  })
  it("is deterministic and does not mutate caller input", () => {
    const snapshot = structuredClone(context)
    const first = parse("fakturer Nordlys 10t konsulent")
    expect(parse("fakturer Nordlys 10t konsulent")).toEqual(first)
    expect(context).toEqual(snapshot)
  })
})
