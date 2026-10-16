import { describe, expect, it } from "vitest"

import { suggestions } from "../suggestion-provider"

const known = {
  invoices: [{ number: "INV-2026-001", customer: "Birk Arkitekter" }, { number: "INV-2026-002", customer: "Studio Vester" }],
  customers: [{ name: "Birk Arkitekter" }, { name: "Studio Vester" }],
}

describe("suggestions", () => {
  it("completes a phrase from its start, and stops once it reads as the request", () => {
    expect(suggestions("vis", null)).toEqual(["vis forfaldne fakturaer", "vis moms"])
    expect(suggestions("vis forf", null)).toEqual(["vis forfaldne fakturaer"])
    expect(suggestions("vis forfaldne", null)).toEqual([])
    expect(suggestions("v", null)).toEqual([])
  })

  it("offers the invoices a credit note can be for, by number or customer, until one is typed in full", () => {
    expect(suggestions("kredit", known)).toEqual(["kreditnota INV-2026-001", "kreditnota INV-2026-002"])
    expect(suggestions("kreditnota INV-", known)).toEqual(["kreditnota INV-2026-001", "kreditnota INV-2026-002"])
    expect(suggestions("kreditnota stu", known)).toEqual(["kreditnota INV-2026-002"])
    expect(suggestions("kreditnota INV-2026-001", known)).toEqual([])
  })

  it("offers customers while the name after fakturer is being typed, and not once a line starts", () => {
    expect(suggestions("fakturer S", known)).toEqual(["fakturer Studio Vester"])
    expect(suggestions("faktura til b", known)).toEqual(["faktura til Birk Arkitekter"])
    expect(suggestions("fakturer Studio Vester", known)).toEqual([])
    expect(suggestions("fakturer Studio Vester 10t", known)).toEqual([])
  })

  it("waits for nothing it does not have", () => {
    expect(suggestions("kreditnota IN", null)).toEqual([])
  })
})
