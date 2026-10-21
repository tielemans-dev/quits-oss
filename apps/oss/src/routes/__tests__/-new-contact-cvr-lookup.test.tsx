// @vitest-environment jsdom
// MOCK: trpc client with a CVR lookup the test controls; the new-contact form is real.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ComponentType } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { I18nProvider } from "../../lib/i18n/react"

const api = vi.hoisted(() => ({
  available: vi.fn(async () => ({ enabled: true })),
  customer: vi.fn(),
  create: vi.fn(), navigate: vi.fn(), search: {} as Record<string, string>,
  businessOnly: false,
}))
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: object) => ({ ...options, useSearch: () => api.search }),
  useNavigate: () => api.navigate,
}))
vi.mock("../../trpc/client", () => ({ trpc: {
  invoices: { sendReadiness: { query: async () => ({ businessBuyersOnly: api.businessOnly }) } },
  settings: { get: { query: async () => ({ countryCode: "DK" }) } },
  cvr: { customerAvailable: { query: api.available }, customer: { query: api.customer } },
  contacts: { create: { mutate: api.create } },
} }))
import { Route } from "../_app/contacts/new"

const Page = (Route as unknown as { component: ComponentType }).component
const validateSearch = (Route as unknown as { validateSearch: (search: Record<string, unknown>) => unknown }).validateSearch
const value = (label: RegExp | string) => (screen.getByLabelText(label) as HTMLInputElement).value
// MOCK: a synthetic company in the register's shape; 24256790 passes the CVR check digit.
const company = {
  cvr: "24256790", name: "MOCK Nordlys ApS", address: "Vestergade 5, 8000 Aarhus C", companyForm: "ApS",
  status: "active", statusClass: "active", momsRegistered: true,
}

beforeEach(() => { vi.clearAllMocks(); api.search = {}; api.businessOnly = false; api.available.mockResolvedValue({ enabled: true }) })
afterEach(cleanup)
describe("new customer CVR lookup", () => {
  it("returns to the document form with the new customer selected, and only to a document form", async () => {
    expect(validateSearch({ returnTo: "https://example.test" })).toEqual({ returnTo: undefined })
    api.search = { returnTo: "/invoices/new" }
    api.create.mockResolvedValue({ id: "new" })
    render(<I18nProvider locale="da-DK"><Page /></I18nProvider>)
    fireEvent.change(screen.getByLabelText(/^Navn/), { target: { value: "Anna Jensen" } })
    await waitFor(() => expect((screen.getByRole("button", { name: "Opret kunde" }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByRole("button", { name: "Opret kunde" }))
    await waitFor(() => expect(api.navigate).toHaveBeenCalledWith({ to: "/invoices/new", search: { contactId: "new" } }))
  })

  it("fills the customer from the register and keeps a name already typed", async () => {
    api.customer.mockResolvedValue(company)
    render(<I18nProvider locale="da-DK"><Page /></I18nProvider>)
    fireEvent.change(screen.getByLabelText(/^Navn/), { target: { value: "Anna Jensen" } })
    fireEvent.change(await screen.findByLabelText("Slå op i CVR"), { target: { value: "DK 2425 6790" } })
    fireEvent.click(screen.getByRole("button", { name: "Slå op" }))
    await screen.findByText("Udfyldt fra CVR-registret. Tjek felterne, før du opretter kunden.")
    expect(api.customer).toHaveBeenCalledWith({ cvr: "24256790" })
    expect(value(/^Navn/)).toBe("Anna Jensen")
    expect(value("Virksomhed")).toBe("MOCK Nordlys ApS")
    expect(value("Adresse")).toBe("Vestergade 5")
    expect(value("Postnr.")).toBe("8000")
    expect(value("By")).toBe("Aarhus C")
    expect(value("CVR/momsnummer")).toBe("24256790")
    expect((screen.getByLabelText("Land") as HTMLSelectElement).value).toBe("DK")
    // Everything stays editable after the lookup.
    fireEvent.change(screen.getByLabelText("By"), { target: { value: "Aarhus N" } })
    expect(value("By")).toBe("Aarhus N")
  })

  it("replaces the name a previous lookup filled in, but keeps one typed over it", async () => {
    // MOCK: a second synthetic company; 21659509 passes the CVR check digit.
    const other = { ...company, cvr: "21659509", name: "MOCK Fjord A/S", address: "Havnegade 1, 9000 Aalborg" }
    api.customer.mockImplementation(async ({ cvr }: { cvr: string }) => cvr === other.cvr ? other : company)
    render(<I18nProvider locale="da-DK"><Page /></I18nProvider>)
    const lookUp = async (cvr: string, filled: string) => {
      fireEvent.change(await screen.findByLabelText("Slå op i CVR"), { target: { value: cvr } })
      fireEvent.click(screen.getByRole("button", { name: "Slå op" }))
      await waitFor(() => expect(value("Virksomhed")).toBe(filled))
    }
    await lookUp("24256790", "MOCK Nordlys ApS")
    expect(value(/^Navn/)).toBe("MOCK Nordlys ApS")
    await lookUp("21659509", "MOCK Fjord A/S")
    expect(value(/^Navn/)).toBe("MOCK Fjord A/S")
    fireEvent.change(screen.getByLabelText(/^Navn/), { target: { value: "Fjord, att. Anna" } })
    await lookUp("24256790", "MOCK Nordlys ApS")
    expect(value(/^Navn/)).toBe("Fjord, att. Anna")
  })

  it("explains an invalid or unknown CVR number without touching the form", async () => {
    api.customer.mockResolvedValue(null)
    render(<I18nProvider locale="en-US"><Page /></I18nProvider>)
    const input = await screen.findByLabelText("CVR lookup")
    fireEvent.change(input, { target: { value: "12345678" } })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(await screen.findByText("Enter a valid CVR number.")).toBeTruthy()
    expect(api.customer).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: "24256790" } })
    fireEvent.click(screen.getByRole("button", { name: "Look up" }))
    expect(await screen.findByText("No company found. Check the CVR number.")).toBeTruthy()
    expect(value("Company")).toBe("")
  })

  it("offers no lookup where the runtime has none, so self-hosted customers are entered by hand", async () => {
    api.available.mockResolvedValue({ enabled: false })
    render(<I18nProvider locale="en-US"><Page /></I18nProvider>)
    await waitFor(() => expect(api.available).toHaveBeenCalled())
    expect(screen.queryByLabelText("CVR lookup")).toBeNull()
    expect(screen.getByLabelText("Company")).toBeTruthy()
  })

  it("shows the business-only hint while the company is empty and drops it once filled", async () => {
    api.businessOnly = true
    api.available.mockResolvedValue({ enabled: false })
    render(<I18nProvider locale="da-DK"><Page /></I18nProvider>)
    expect(await screen.findByText("Kunder skal være virksomheder.")).toBeTruthy()
    fireEvent.change(screen.getByLabelText("Virksomhed"), { target: { value: "Jensen ApS" } })
    expect(screen.queryByText("Kunder skal være virksomheder.")).toBeNull()
    fireEvent.change(screen.getByLabelText("Virksomhed"), { target: { value: " " } })
    expect(screen.getByText("Kunder skal være virksomheder.")).toBeTruthy()
  })
})
