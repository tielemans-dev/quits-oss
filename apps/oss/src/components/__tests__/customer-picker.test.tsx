// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest"
const api = vi.hoisted(() => ({ available: vi.fn(), search: vi.fn(), lookup: vi.fn(), create: vi.fn(), navigate: vi.fn() }))
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => api.navigate }))
vi.mock("../../trpc/client", () => ({ trpc: {
  contacts: { create: { mutate: api.create } },
  cvr: { customerAvailable: { query: api.available }, customerSearch: { query: api.search }, customer: { query: api.lookup } },
} }))
import { I18nProvider } from "../../lib/i18n/react"
import { CustomerPicker } from "../customer-picker"
const firma = { cvr: "24256790", name: "Firma ApS", address: "Gade 1, 8000 Aarhus C", companyForm: "ApS", status: "active", statusClass: "active", momsRegistered: true, email: "faktura@firma.test" }
const andet = { ...firma, cvr: "10150817", name: "Andet A/S", email: null }
const props = { id: "contact", value: "", onChange: vi.fn(), onCreated: vi.fn() }
const open = (contacts: { id: string; name: string; taxId?: string | null }[] = []) => {
  render(<I18nProvider locale="da-DK"><CustomerPicker {...props} contacts={contacts} /></I18nProvider>)
  fireEvent.click(screen.getByRole("combobox"))
}
const type = (value: string) => fireEvent.change(screen.getByPlaceholderText(/Firmanavn eller CVR-nummer|Vælg en kunde/), { target: { value } })
beforeAll(() => {
  // MOCK: jsdom has no ResizeObserver or scrollIntoView, which the popover and command list use.
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} })
  Element.prototype.scrollIntoView = () => {}
})
beforeEach(() => {
  api.available.mockResolvedValue({ enabled: true }); api.search.mockResolvedValue([firma, andet]); api.lookup.mockResolvedValue(firma)
  api.create.mockResolvedValue({ id: "new", name: firma.name, reused: false })
})
afterEach(() => { cleanup(); vi.resetAllMocks() })
it("asks a new user for a name, then adds the register's company with a required invoice email", async () => {
  render(<I18nProvider locale="da-DK"><CustomerPicker {...props} contacts={[]} /></I18nProvider>)
  await screen.findByText("Hvem skal have fakturaen? Skriv firmanavn eller CVR-nummer.")
  fireEvent.click(screen.getByRole("combobox"))
  type("Fi"); type("Firma")
  fireEvent.click(await screen.findByRole("option", { name: /Firma ApS/ }))
  expect(api.search).toHaveBeenCalledTimes(1)
  expect(api.search).toHaveBeenCalledWith({ q: "Firma" }, expect.anything())
  expect(screen.getByText(`CVR ${firma.cvr}`)).toBeTruthy()
  const email = screen.getByLabelText(/E-mail til faktura/) as HTMLInputElement
  expect(email.value).toBe(firma.email)
  fireEvent.change(email, { target: { value: "" } })
  fireEvent.click(screen.getByRole("button", { name: "Tilføj kunde" }))
  await screen.findByText("Skriv en gyldig e-mailadresse.")
  expect(api.create).not.toHaveBeenCalled()
  fireEvent.change(email, { target: { value: "bogholderi@firma.test" } })
  fireEvent.click(screen.getByRole("button", { name: "Tilføj kunde" }))
  await waitFor(() => expect(props.onCreated).toHaveBeenCalledWith("new"))
  expect(api.create).toHaveBeenCalledWith({
    name: firma.name, company: firma.name, address: "Gade 1", zip: "8000", city: "Aarhus C", country: "DK", taxId: firma.cvr, email: "bogholderi@firma.test", reuseCvr: true,
  })
})
it("looks eight digits up by CVR number and keeps an email the person typed", async () => {
  open()
  await screen.findByPlaceholderText("Firmanavn eller CVR-nummer")
  type("Andet")
  fireEvent.click(await screen.findByRole("option", { name: /Andet A\/S/ }))
  fireEvent.change(screen.getByLabelText(/E-mail til faktura/), { target: { value: "typed@andet.test" } })
  fireEvent.click(screen.getByRole("button", { name: "Tilbage" }))
  type("2425 6790")
  fireEvent.click(await screen.findByRole("option", { name: /Firma ApS/ }))
  expect(api.lookup).toHaveBeenCalledWith({ cvr: firma.cvr }, expect.anything())
  expect(api.search).toHaveBeenCalledTimes(1)
  expect((screen.getByLabelText(/E-mail til faktura/) as HTMLInputElement).value).toBe("typed@andet.test")
})
it("lists existing customers in the same picker and does not offer their CVR twice", async () => {
  open([{ id: "old", name: "Firma ApS", taxId: "DK 24256790" }, { id: "other", name: "Kunde B" }])
  await screen.findByPlaceholderText("Firmanavn eller CVR-nummer")
  type("Firma")
  await screen.findByRole("option", { name: /Andet A\/S/ })
  expect(screen.getAllByRole("option", { name: /Firma ApS/ })).toHaveLength(1)
  fireEvent.click(screen.getByRole("option", { name: /Firma ApS/ }))
  expect(props.onChange).toHaveBeenCalledWith("old")
})
it("offers only the customer list and the manual path without a CVR lookup", async () => {
  api.available.mockResolvedValue({ enabled: false })
  open([{ id: "other", name: "Kunde B" }])
  type("Kunde")
  await new Promise(resolve => setTimeout(resolve, 300))
  expect(api.search).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("option", { name: "Opret manuelt" }))
  expect(api.navigate).toHaveBeenCalledWith({ to: "/contacts/new", search: { returnTo: "/invoices/new" } })
})
