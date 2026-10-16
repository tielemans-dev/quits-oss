import { describe, expect, it } from "vitest"

import { customersIn, writtenRequests } from "../decision-provider"

const known = {
  invoices: [
    { number: "INV-2026-001", customer: "Birk Arkitekter", status: "sent", balanceDue: 12500.5, currency: "DKK" },
    { number: "INV-2026-002", customer: "Birk Arkitekter", status: "draft", balanceDue: 900, currency: "DKK" },
    { number: "INV-2026-003", customer: "Studio Vester", status: "paid", balanceDue: 0, currency: "DKK" },
  ],
  customers: [{ name: "Birk Arkitekter" }, { name: "Havblik Design" }, { name: "Studio Vester" }, { name: "Studio Nord" }],
}

describe("customersIn", () => {
  it("finds a customer by its whole name, its first word, a near miss or the start of it", () => {
    expect(customersIn("faktura til havblik design", known.customers)).toEqual(["Havblik Design"])
    expect(customersIn("annuller fakturaen til birk", known.customers)).toEqual(["Birk Arkitekter"])
    expect(customersIn("hablik skal have en faktura", known.customers)).toEqual(["Havblik Design"])
    expect(customersIn("send til havb", known.customers)).toEqual(["Havblik Design"])
  })

  it("keeps every customer that fits as well, and none for a sentence that names nobody", () => {
    expect(customersIn("studio skal have en faktura", known.customers)).toEqual(["Studio Vester", "Studio Nord"])
    expect(customersIn("studio vester skal have en faktura", known.customers)).toEqual(["Studio Vester"])
    expect(customersIn("hvem skylder mig penge", known.customers)).toEqual([])
  })
})

describe("writtenRequests", () => {
  it("writes an invoice with the hours and price as typed", () => {
    expect(writtenRequests("invoice", "havblik skal have en faktura på 5 timer à 800 kr", known).requests).toEqual(["fakturer Havblik Design 5t à 800 kr"])
    expect(writtenRequests("invoice", "send birk en regning på 5000 kr", known).requests).toEqual(["fakturer Birk Arkitekter 5000 kr"])
    expect(writtenRequests("invoice", "lav en ny regning", known)).toEqual({ requests: [], start: "fakturer " })
  })

  it("credits only issued invoices, and records a payment for what is still owed", () => {
    expect(writtenRequests("creditNote", "annuller fakturaen til birk", known).requests).toEqual(["kreditnota INV-2026-001"])
    expect(writtenRequests("payment", "birk har betalt", known).requests).toEqual(["betaling modtaget fra Birk Arkitekter 12.500,50 kr ref INV-2026-001"])
    expect(writtenRequests("payment", "birk har betalt 4.000 kr", known).requests).toEqual(["betaling modtaget fra Birk Arkitekter 4.000 kr"])
  })

  it("only creates a customer for a CVR number or when asked to", () => {
    expect(writtenRequests("customer", "opret kunden med cvr 1234 5678", known).requests).toEqual(["cvr 12345678"])
    expect(writtenRequests("customer", "opret en ny kunde", known).requests).toEqual(["ny kunde"])
    expect(writtenRequests("customer", "vis mine kunder", known).requests).toEqual([])
  })
})
