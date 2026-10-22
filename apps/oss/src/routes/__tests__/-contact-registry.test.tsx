// @vitest-environment jsdom
// MOCK: trpc client; the customer page and form are real.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ComponentType } from "react"
import { afterEach, expect, it, vi } from "vitest"
import { I18nProvider } from "../../lib/i18n/react"
import { handledMutationError } from "../../lib/query-refresh"

const api = vi.hoisted(() => ({ get: vi.fn(), refresh: vi.fn(), available: vi.fn(), search: {} as { edit?: boolean } }))
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: object) => ({ ...options, useParams: () => ({ contactId: "buyer" }), useSearch: () => api.search }),
  useNavigate: () => vi.fn(),
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a>,
}))
vi.mock("../../trpc/client", () => ({ trpc: {
  invoices: { sendReadiness: { query: async () => ({ businessBuyersOnly: false }) } },
  cvr: { customerAvailable: { query: api.available } },
  contacts: { get: { query: api.get }, refreshFromCvr: { mutate: api.refresh } },
} }))
import { Route } from "../_app/contacts/$contactId"
const Page = (Route as unknown as { component: ComponentType }).component
// MOCK: jsdom has no ResizeObserver, which the billing address switch uses.
vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} })
afterEach(() => { cleanup(); vi.resetAllMocks(); api.search = {} })

// MOCK: a synthetic CVR customer billed at its own address; 24256790 passes the CVR check digit.
const customer = {
  id: "buyer", name: "Anna Jensen", email: null, company: "MOCK Nordlys ApS", taxId: "24256790", country: "DK",
  address: "Postboks 12", zip: "8100", city: "Aarhus C", registrySource: "cvr",
  registeredAddress: "Vestergade 5", registeredZip: "8000", registeredCity: "Aarhus C",
}

it("refreshes a CVR customer from the register and shows its registered address beside billing", async () => {
  api.available.mockResolvedValue({ enabled: true })
  api.get.mockResolvedValue(customer)
  api.refresh.mockImplementation(async () => { api.get.mockResolvedValue({ ...customer, company: "MOCK Nordlys A/S" }) })
  render(<I18nProvider locale="da-DK"><Page /></I18nProvider>)
  expect(await screen.findByText("Registreret adresse")).toBeTruthy()
  fireEvent.click(await screen.findByRole("button", { name: "Opdater fra CVR" }))
  await waitFor(() => expect(api.refresh).toHaveBeenCalledExactlyOnceWith({ id: "buyer" }, handledMutationError))
  expect((await screen.findAllByText("MOCK Nordlys A/S")).length).toBeGreaterThan(0)
})

it("locks a CVR customer's name and number and keeps its own billing address editable", async () => {
  api.search = { edit: true }
  api.available.mockResolvedValue({ enabled: false })
  api.get.mockResolvedValue(customer)
  render(<I18nProvider locale="en-US"><Page /></I18nProvider>)
  expect(((await screen.findByLabelText("Company")) as HTMLInputElement).readOnly).toBe(true)
  expect((screen.getByLabelText("Tax ID") as HTMLInputElement).readOnly).toBe(true)
  expect(screen.getByText("The name and CVR number follow the CVR register.")).toBeTruthy()
  expect((screen.getByRole("switch", { name: "Use registered address" })).getAttribute("aria-checked")).toBe("false")
  expect((screen.getByLabelText("Address") as HTMLInputElement).value).toBe("Postboks 12")
})

it("leaves a manual customer fully editable and offers no refresh without a lookup", async () => {
  api.search = { edit: true }
  api.available.mockResolvedValue({ enabled: false })
  api.get.mockResolvedValue({ ...customer, registrySource: null, registeredAddress: null, registeredZip: null, registeredCity: null })
  render(<I18nProvider locale="en-US"><Page /></I18nProvider>)
  expect(((await screen.findByLabelText("Company")) as HTMLInputElement).readOnly).toBe(false)
  expect(screen.queryByRole("switch")).toBeNull()
  expect(screen.queryByRole("button", { name: "Update from CVR" })).toBeNull()
})
