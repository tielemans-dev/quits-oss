// @vitest-environment jsdom
// MOCK: organization/session and settings transport fixtures are test-only; the form and hooks are real.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

const fixture = vi.hoisted(() => ({ load: vi.fn(), settings: vi.fn() }))
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tanstack/react-router")>(),
  createFileRoute: () => (options: object) => ({ ...options, useSearch: () => ({}) }),
  useNavigate: () => vi.fn(),
}))
vi.mock("../../lib/active-organization", () => ({ getRequestOrganizationId: () => "synthetic-org", useRequestOrganizationId: () => "synthetic-org" }))
vi.mock("../../lib/organization-settings-query", () => ({ loadOrganizationSettings: fixture.load }))
vi.mock("../../trpc/client", () => ({ trpc: {
  settings: { get: { query: fixture.settings } },
  contacts: { list: { query: async () => [{ id: "c1", name: "Acme ApS" }] } },
  catalog: { list: { query: async () => [] } },
  invoices: { sendReadiness: { query: async () => ({ issues: [], baseCurrency: "DKK", taxRate: "25", pricesIncludeTax: false, momsRegistered: true, countryCode: "DK", recipient: null, recipientVersion: null }) } },
  runtime: { capabilities: { query: async () => ({ aiInvoiceDraft: { enabled: false } }) } },
} }))
vi.mock("../../lib/i18n/react", () => ({ useI18n: () => ({ t: (key: string) => key, locale: "da-DK" }) }))

import { Route } from "../_app/invoices/new"

const Component = (Route as unknown as { component: () => React.ReactNode }).component

beforeAll(() => {
  // Radix Select and the customer picker's popover need these in jsdom.
  Element.prototype.hasPointerCapture = () => false
  Element.prototype.scrollIntoView = () => {}
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} })
})

async function submit() {
  fireEvent.click(await screen.findByRole("button", { name: "docForm.action.saveDraft" }))
}

async function pickCustomer() {
  fireEvent.click((await screen.findAllByRole("combobox"))[0])
  fireEvent.click(await screen.findByRole("option", { name: "Acme ApS" }))
}

describe("new invoice stale field errors", () => {
  beforeEach(() => {
    fixture.load.mockResolvedValue({ paymentTermsDays: 14, timezone: "Europe/Copenhagen", taxRate: 25 })
    fixture.settings.mockResolvedValue({ baseCurrency: "DKK" })
  })
  afterEach(cleanup)

  it("focuses the summary and lets each link focus its field", async () => {
    render(<Component />)
    await waitFor(() => expect(screen.queryByText("docForm.loadingContacts")).toBeNull())
    await submit()
    const summary = screen.getByRole("alert", { name: "summary.title.other" })
    expect(document.activeElement).toBe(summary)
    const links = within(summary).getAllByRole("link")
    fireEvent.click(links[0])
    expect(document.activeElement).toBe(document.getElementById("invoice-contact"))
    fireEvent.click(links[1])
    expect(document.activeElement).toBe(screen.getByLabelText("docForm.column.description"))
    await pickCustomer()
    fireEvent.change(screen.getByLabelText("docForm.column.description"), { target: { value: "Consulting" } })
    expect(screen.queryByRole("alert", { name: /summary.title/ })).toBeNull()
  })

  it("keeps the other invalid line fields in the summary while one is corrected", async () => {
    render(<Component />)
    await waitFor(() => expect(screen.queryByText("docForm.loadingContacts")).toBeNull())
    const quantity = screen.getByLabelText("docForm.column.qty")
    fireEvent.change(quantity, { target: { value: "bad" } })
    await submit()
    fireEvent.change(quantity, { target: { value: "2" } })
    expect(screen.getByRole("link", { name: "docForm.column.description 1: invoiceValidation.required" })).toBeTruthy()
    expect(screen.queryByRole("link", { name: /docForm.column.qty 1:/ })).toBeNull()
  })

  it("clears the customer error as soon as a customer is picked", async () => {
    render(<Component />)
    await waitFor(() => expect(screen.queryByText("docForm.loadingContacts")).toBeNull())
    await submit()
    expect(await screen.findByText("invoiceValidation.customer.required")).toBeTruthy()
    await pickCustomer()
    await waitFor(() => expect(screen.queryByText("invoiceValidation.customer.required")).toBeNull())
  })

  it("clears the line description error once a description is typed", async () => {
    render(<Component />)
    await waitFor(() => expect(screen.queryByText("docForm.loadingContacts")).toBeNull())
    await pickCustomer()
    await submit()
    expect((await screen.findAllByText("invoiceValidation.required")).length).toBeGreaterThan(0)
    const before = screen.getAllByText("invoiceValidation.required").length
    fireEvent.change(screen.getByLabelText("docForm.column.description"), { target: { value: "Consulting" } })
    await waitFor(() => expect(screen.queryAllByText("invoiceValidation.required").length).toBeLessThan(before))
  })
})
