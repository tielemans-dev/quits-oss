// @vitest-environment jsdom
// MOCK: organization/session and settings transport fixtures are test-only; the form and hooks are real.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

const fixture = vi.hoisted(() => ({ navigate: vi.fn() }))
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tanstack/react-router")>(),
  createFileRoute: () => (options: unknown) => options,
  useNavigate: () => fixture.navigate,
}))
vi.mock("../../lib/active-organization", () => ({ useRequestOrganizationId: () => "synthetic-org" }))
vi.mock("../../lib/organization-settings-query", () => ({ loadOrganizationSettings: async () => ({ paymentTermsDays: 14, timezone: "Europe/Copenhagen", taxRate: 25 }) }))
vi.mock("../../trpc/client", () => ({ trpc: {
  settings: { get: { query: async () => ({ baseCurrency: "DKK" }) } },
  contacts: { list: { query: async () => [{ id: "c1", name: "Acme ApS" }] } },
  catalog: { list: { query: async () => [] } },
  invoices: { sendReadiness: { query: async () => ({ issues: [], baseCurrency: "DKK", taxRate: "25", pricesIncludeTax: false, momsRegistered: true, countryCode: "DK", recipient: null, recipientVersion: null }) } },
  runtime: { capabilities: { query: async () => ({ aiInvoiceDraft: { enabled: false } }) } },
} }))
vi.mock("../../lib/i18n/react", () => ({ useI18n: () => ({ t: (key: string) => key, locale: "da-DK" }) }))

import { clearHandoff, handOff, readHandoff } from "../../lib/request-handoff"
import { Route } from "../_app/invoices/new"

const Component = (Route as unknown as { component: () => React.ReactNode }).component
const draft = {
  input: "faktura til Acme 2,5 timer à 850 kr. konsulent", contactId: "c1", dueDate: "2026-12-01",
  issuance: { supplyDate: "2026-10-01", exchangeRate: "", rateDate: "2026-10-01" }, taxRate: "25", pricesIncludeTax: false, vatEvidence: {}, notes: "Tak",
  items: [{ description: "konsulent", quantity: "2,5", unitPrice: "850" }],
}

beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false
  Element.prototype.scrollIntoView = () => {}
})
afterEach(() => { cleanup(); clearHandoff(); fixture.navigate.mockReset() })

describe("new invoice opened from the request card", () => {
  it("is pre-filled and says where it came from", async () => {
    handOff("form", draft)
    render(<Component />)

    expect(await screen.findByDisplayValue("konsulent")).toBeTruthy()
    expect(screen.getByDisplayValue("2,5")).toBeTruthy()
    expect(screen.getByDisplayValue("Tak")).toBeTruthy()
    expect(screen.getByText("invoices.new.fromRequest")).toBeTruthy()
    expect(readHandoff("form")).toBeNull()
  })

  it("takes every edit back to the card on Tilbage til forslaget", async () => {
    handOff("form", draft)
    render(<Component />)
    fireEvent.change(await screen.findByDisplayValue("konsulent"), { target: { value: "rådgivning" } })

    fireEvent.click(screen.getByRole("button", { name: "invoices.new.backToRequest" }))

    expect(readHandoff("card")).toMatchObject({ input: draft.input, contactId: "c1", notes: "Tak", items: [{ description: "rådgivning", quantity: "2.5", unitPrice: "850" }] })
    expect(fixture.navigate).toHaveBeenCalledWith({ to: "/" })
  })

  it("is the plain form when nothing was handed over", async () => {
    render(<Component />)

    await waitFor(() => expect(screen.queryByText("docForm.loadingContacts")).toBeNull())
    expect(screen.queryByText("invoices.new.fromRequest")).toBeNull()
    expect(screen.queryByRole("button", { name: "invoices.new.backToRequest" })).toBeNull()
  })
})
