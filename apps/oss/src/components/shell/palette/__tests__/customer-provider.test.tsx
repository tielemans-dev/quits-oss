// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { I18nProvider } from "../../../../lib/i18n/react"
import { CustomerCard, customersFor } from "../customer-provider"
import type { PaletteActions } from "../types"

afterEach(cleanup)

const known = {
  invoices: [
    { number: "INV-2026-004", customer: "Birk Arkitekter", status: "sent", balanceDue: 4000, currency: "DKK", dueDate: "2999-01-01" },
    { number: "INV-2026-001", customer: "Birk Arkitekter", status: "overdue", balanceDue: 18500, currency: "DKK", dueDate: "2020-01-01" },
    { number: "INV-2026-002", customer: "Birk Arkitekter", status: "paid", balanceDue: 0, currency: "DKK", dueDate: "2020-01-01" },
    { number: "INV-2026-005", customer: "Birk Arkitekter", status: "draft", balanceDue: 900, currency: "DKK", dueDate: "2999-01-01" },
  ],
  customers: [{ name: "Birk Arkitekter" }, { name: "Studio Vester" }, { name: "Nord Studio" }, { name: "Havblik Design" }],
}

describe("customersFor", () => {
  it("finds customers by the start of their name, then of any word in it", () => {
    expect(customersFor("birk", known)).toEqual(["Birk Arkitekter"])
    expect(customersFor("vester", known)).toEqual(["Studio Vester"])
    expect(customersFor("studio", known)).toEqual(["Studio Vester", "Nord Studio"])
  })

  it("waits for three letters, and names nobody for text that fits no one", () => {
    expect(customersFor("st", known)).toEqual([])
    expect(customersFor("fakturer", known)).toEqual([])
  })
})

describe("CustomerCard", () => {
  const actions = (): PaletteActions => ({ navigate: vi.fn(), close: vi.fn(), expand: vi.fn(), fill: vi.fn() })

  it("shows what the customer owes and their issued invoices, the late one as late", () => {
    render(<I18nProvider locale="da-DK"><CustomerCard name="Birk Arkitekter" known={known} actions={actions()} /></I18nProvider>)
    expect(screen.getByText(/Udestående/).textContent).toContain("22.500,00")
    expect(screen.queryByText("INV-2026-005")).toBeNull()
    expect(screen.getByText("Forfalden")).toBeTruthy()
    expect(screen.getByText("Åben")).toBeTruthy()
    expect(screen.getByText("Betalt")).toBeTruthy()
  })

  it("writes the request a chip stands for into the field", () => {
    const given = actions()
    render(<I18nProvider locale="da-DK"><CustomerCard name="Birk Arkitekter" known={known} actions={given} /></I18nProvider>)
    fireEvent.click(screen.getByRole("button", { name: /Som sidst/ }))
    expect(given.fill).toHaveBeenLastCalledWith("fakturer Birk Arkitekter som sidst")
    fireEvent.click(screen.getByRole("button", { name: /Betaling modtaget/ }))
    expect(given.fill).toHaveBeenLastCalledWith("betaling modtaget fra Birk Arkitekter 4.000 kr ref INV-2026-004")
    fireEvent.click(screen.getByRole("button", { name: /Kreditnota/ }))
    expect(given.fill).toHaveBeenLastCalledWith("kreditnota INV-2026-004")
  })
})
