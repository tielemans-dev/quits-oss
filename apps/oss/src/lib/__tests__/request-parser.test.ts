import { describe, expect, it } from "vitest"
import { previewDraft } from "@quits/shared/pricing"
import { quantityDecimalSchema, unitPriceDecimalSchema } from "@quits/contracts/invoices"
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
    expect(parse("vis forfaldne fra sidste måned")?.confidence).toBeLessThan(1)
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
    expect(parse("fakturer Nordls 10t")?.customer?.status).toBe("suggested")
    const customers = [...context.customers, { id: "other", name: "Nordlys ApS Design" }]
    expect(parse("fakturer Nordlys ApS 10t", { ...context, customers })?.customer?.candidates).toEqual(context.customers)
  })
  it("distinguishes a fuzzy customer suggestion from an exact match", () => {
    const customers = [{ id: "p", name: "Peter Jansen" }]
    const suggested = parse("fakturer Peter Hansen 2 timer à 850 kr.", { ...context, customers })
    expect(suggested?.customer?.status).toBe("suggested")
    expect(suggested?.confidence).toBeLessThan(1)
    expect(parse("fakturer Peter Jansen 2 timer à 850 kr.", { ...context, customers })?.customer?.status).toBe("matched")
  })
  it.each(["Studio 54 ApS", "3Shape A/S"])("keeps digits in customer names: %s", name => {
    const customers = [{ id: "studio", name: "Studio" }, { id: "digits", name }]
    for (const suffix of ["", " 2 timer à 850 kr."]) {
      expect(parse(`fakturer ${name}${suffix}`, { ...context, customers })?.customer).toMatchObject({
        status: "matched", query: name, candidates: [{ id: "digits", name }],
      })
    }
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
  it.each(["", "Nordlys", "find faktura til Nordlys", "vis forfaldnes", "faktureringsadresse", "lav en kaffe",
    "fakturer", "faktura til", "fakturer 2024", "fakturer-liste"])("leaves ordinary search unchanged: %s", input => {
    expect(parse(input)).toBeNull()
  })
  it.each(["-2 timer", "1,2345678 timer", "1.25 kr.", "1e3 kr."])("preserves unsupported numbers: %s", text => {
    const draft = parse(`fakturer Nordlys ${text}`)
    expect(draft?.items).toEqual([])
    expect(draft?.remainder).toBe(text)
  })
  it.each(["1 250", "1\u00a0250", "1\u202f250"])("reads a whole space-grouped amount: %s", amount => {
    for (const text of [`${amount} kr.`, `12 timer à ${amount} kr.`]) {
      const draft = parse(`fakturer Nordlys ${text}`)
      expect(draft?.items[0]?.unitPrice).toBe("1250")
      expect(draft?.remainder).toBe("")
    }
  })
  it.each(["0.250", "0 250", "0\u00a0250", "0\u202f250", "00.250", "012", "00", "00,25"])("refuses leading-zero prices: %s", amount => {
    for (const prefix of ["", "12 timer à "]) {
      const draft = parse(`fakturer Nordlys ${prefix}${amount} kr.`)
      expect(draft?.items[0]?.unitPrice).toBeUndefined()
      expect(draft?.remainder).toBe(`${prefix ? "à " : ""}${amount.replace(/\s/g, " ")} kr.`)
    }
  })
  it.each(["012", "00", "00,25", "0.250", "0 250"])("refuses leading-zero quantities: %s", quantity => {
    const draft = parse(`fakturer Nordlys ${quantity} timer à 850 kr.`)
    expect(draft?.items).toEqual([])
    expect(draft?.remainder).toBe(`${quantity} timer à 850 kr.`)
  })
  it.each(["-", "\u2013", "\u2014", "\u2212"])("preserves dash signs and separators: %s", dash => {
    for (const gap of ["", " "]) {
      for (const prefix of ["", "12 timer à ", "12 timer "]) {
        const draft = parse(`fakturer Nordlys ${prefix}${dash}${gap}850 kr.`)
        expect(draft?.customer?.query).toBe("Nordlys")
        expect(draft?.items[0]?.unitPrice).toBeUndefined()
        expect(draft?.remainder).toBe(`${prefix.includes("à") ? "à " : ""}${dash}${gap}850 kr.`)
      }
    }
  })
  it("accepts zero prices and decimal fractions starting with zero", () => {
    expect(parse("fakturer Nordlys 0 kr.")?.items[0]?.unitPrice).toBe("0")
    expect(parse("fakturer Nordlys 0,25 timer à 0,250 kr.")?.items[0]).toMatchObject({ quantity: "0.25", unitPrice: "0.250" })
  })
  it.each(["- 850 kr.", "- 2 timer à 850 kr.", "1 25 kr.", "12 timer à 1 25 kr.", "12 timer à - 850 kr.",
    "850,12345 kr.", "12 timer à 850,12345 kr.", "1.000.000.001 kr.", "12 timer à 1.000.000.001 kr."])("does not emit a price from unsupported input: %s", text => {
    const draft = parse(`fakturer Nordlys ${text}`)
    expect(draft?.customer?.query).toBe("Nordlys")
    expect(draft?.items[0]?.unitPrice).toBeUndefined()
    expect(draft?.remainder).toBe(text.startsWith("12 timer") ? text.slice(9) : text)
  })
  it.each([
    ["1,5 timer à 1.250,50", "1.5", "1250.50"], ["2 timer à 1.250", "2", "1250"],
    ["2 timer à 1 250", "2", "1250"], ["2 timer à 0,1234", "2", "0.1234"],
    ["1 timer à 1.000.000.000", "1", "1000000000"], ["1.000.000 timer à 0,0001", "1000000", "0.0001"],
  ])("matches invoice form line amounts for %s", (text, quantity, unitPrice) => {
    const draft = parse(`fakturer Nordlys ${text} kr. konsulent`)!
    expect(draft.items[0]).toMatchObject({ quantity, unitPrice })
    expect(quantityDecimalSchema.safeParse(draft.items[0]?.quantity).success).toBe(true)
    expect(unitPriceDecimalSchema.safeParse(draft.items[0]?.unitPrice).success).toBe(true)
    for (const pricesIncludeTax of [false, true]) {
      const options = { currency: "DKK", taxRate: "25", pricesIncludeTax }
      const parsed = previewDraft({ ...options, items: draft.items.map(item => ({ ...item, quantity: item.quantity!, unitPrice: item.unitPrice! })) })
      const form = previewDraft({ ...options, items: [normalizeInvoiceQuantity({ description: "Konsulentarbejde", quantity: quantity.replace(".", ","), unitPrice }, "da-DK")] })
      expect(parsed.result).not.toBeNull()
      expect(parsed).toEqual(form)
    }
  })
  it.each([["1.000.001 timer à 850 kr.", "1000001", "850"], ["2 timer à 0,12345 kr.", "2", "0.12345"],
    ["2 timer à 1.000.000.001 kr.", "2", "1000000001"]])("refuses values beyond the invoice contract: %s", (text, quantity, unitPrice) => {
    expect(quantityDecimalSchema.safeParse(quantity).success && unitPriceDecimalSchema.safeParse(unitPrice).success).toBe(false)
    const line = parse(`fakturer Nordlys ${text}`)?.items[0]
    expect(line?.quantity && line.unitPrice).toBeFalsy()
  })
  it.each([0.12345, 1_000_000_001])("validates catalogue prices against the same contract: %s", defaultUnitPrice => {
    const catalogItems = [{ ...context.catalogItems[0]!, defaultUnitPrice }]
    expect(parse("fakturer Nordlys 10t konsulent", { ...context, catalogItems })?.items[0]?.unitPrice).toBeUndefined()
  })
  it("is deterministic and does not mutate caller input", () => {
    const snapshot = structuredClone(context)
    const first = parse("fakturer Nordlys 10t konsulent")
    expect(parse("fakturer Nordlys 10t konsulent")).toEqual(first)
    expect(context).toEqual(snapshot)
  })
})
