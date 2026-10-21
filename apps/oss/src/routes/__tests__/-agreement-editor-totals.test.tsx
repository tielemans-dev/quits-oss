// @vitest-environment jsdom
// MOCK: settings, contacts and templates transport fixtures are test-only; the editor, pricing and labels are real.
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { I18nProvider } from "../../lib/i18n/react"

const fixture = vi.hoisted(() => ({ settings: {} as Record<string, unknown> }))
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tanstack/react-router")>(),
  useNavigate: () => vi.fn(),
}))
vi.mock("../../trpc/client", () => ({ trpc: {
  agreements: {
    capabilities: { query: async () => ({ depositsEnabled: false }) },
    listTemplates: { query: async () => [] },
  },
  contacts: { list: { query: async () => [] } },
  settings: { get: { query: async () => fixture.settings } },
} }))

import { AgreementEditor } from "../_app/agreements/-editor"

const dk = { companyName: "Studio ApS", defaultCurrency: "DKK", countryCode: "DK", taxRegime: "eu_vat", pricesIncludeTax: false }
// Formatted amounts separate digits and currency with non-breaking spaces.
const text = () => document.body.textContent!.replace(/ /g, " ")

beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false
  Element.prototype.scrollIntoView = () => {}
})
afterEach(cleanup)

describe("agreement editor totals", () => {
  it("starts a VAT-registered seller on the saved rate and shows the total the draft is saved with", async () => {
    fixture.settings = { ...dk, taxRate: 25, momsRegistered: true }
    render(<I18nProvider locale="da-DK"><AgreementEditor /></I18nProvider>)
    expect((await screen.findByLabelText("Momssats (%)") as HTMLInputElement).value).toBe("25")
    fireEvent.change(screen.getByLabelText("Enhedspris ekskl. moms"), { target: { value: "9500" } })
    expect(text()).toContain("Subtotal ekskl. moms9.500,00 kr.")
    expect(text()).toContain("Moms2.375,00 kr.")
    expect(text()).toContain("Ydelser i alt inkl. moms11.875,00 kr.")
  })
  it("starts a seller without VAT on 0 % and states no VAT side", async () => {
    fixture.settings = { ...dk, taxRate: 25, momsRegistered: false }
    render(<I18nProvider locale="da-DK"><AgreementEditor /></I18nProvider>)
    expect((await screen.findByLabelText("Momssats (%)") as HTMLInputElement).value).toBe("0")
    fireEvent.change(screen.getByLabelText("Enhedspris"), { target: { value: "9500" } })
    expect(text()).toContain("Ydelser i alt9.500,00 kr.")
    expect(text()).not.toContain("moms9.500")
  })
})
