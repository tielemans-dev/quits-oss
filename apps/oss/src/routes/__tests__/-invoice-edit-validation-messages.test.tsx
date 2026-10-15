// @vitest-environment jsdom
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { I18nProvider } from "../../lib/i18n/react"
// MOCK: transport responses and route context only. The edit form, error mapping and catalogs are real.
const api = vi.hoisted(() => ({ get: vi.fn(), settings: vi.fn(), update: vi.fn() }))
vi.mock("../../trpc/client", () => ({ trpc: {
  invoices: { get: { query: api.get }, updateV2: { mutate: api.update } }, settings: { get: { query: api.settings } },
  contacts: { list: { query: async () => [{ id: "buyer", name: "Synthetic buyer" }] } }, catalog: { list: { query: async () => [] } },
  paymentDetails: { firstSendReadiness: { query: async () => ({ bankMissing: false }) } },
} }))
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: object) => ({ ...options, useParams: () => ({ invoiceId: "draft" }), useSearch: () => ({}) }),
  useNavigate: () => vi.fn(),
  Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => <a href={to} {...props}>{children}</a>,
}))
vi.mock("../../components/billing/trial-access", () => ({ useTrialAccess: () => null, isReadOnly: () => false, PaywallBlock: () => null }))
vi.mock("../../components/invoices/panels", () => ({ InvoiceLifecyclePanels: () => null }))
import { Route } from "../_app/invoices/$invoiceId"
const Detail = (Route as unknown as { component: () => ReactNode }).component
const draft = {
  id: "draft", number: null, status: "draft", paymentStatus: "unpaid", purpose: "sale", currency: "DKK", taxRegime: "eu_vat",
  dueDate: "2026-11-09", issueDate: "2026-10-13", supplyDate: "2026-10-13", total: 0, subtotal: 0, taxAmount: 0,
  items: [{ id: "i1", description: "Work", quantity: 1, unitPrice: 100, taxRate: 0 }],
  contact: { id: "buyer", name: "Synthetic buyer", email: "buyer@example.test" }, sellerSnapshot: { countryCode: "DK", momsRegistered: false },
}
const rawJson = JSON.stringify([
  { origin: "string", code: "too_small", path: ["items", 0, "description"], message: "Too small: expected string to have >=1 characters" },
  { code: "invalid_type", path: ["items", 0, "quantity"], message: "Invalid input" },
  { code: "weird", path: ["somethingElse"], message: "raw" },
])
beforeEach(() => {
  vi.resetAllMocks()
  api.get.mockResolvedValue(draft)
  api.settings.mockResolvedValue({ baseCurrency: "DKK", emailDelivery: { available: true } })
})
afterEach(cleanup)

describe.each([
  ["da-DK", { edit: "Rediger", save: "Gem ændringer", description: "Beskriv, hvad du fakturerer for", qty: "Indtast et antal, fx 1 eller 2,5", unknown: "Tjek feltet og prøv igen", failed: "Vi kunne ikke gemme lige nu. Prøv igen om et øjeblik." }],
  ["en-GB", { edit: "Edit", save: "Save Changes", description: "Describe what you're invoicing for", qty: "Enter a quantity, like 1 or 2.5", unknown: "Check this field and try again", failed: "We couldn't save right now. Try again in a moment." }],
])("invoice edit validation messages in %s", (locale, copy) => {
  async function openEditor() {
    render(<I18nProvider locale={locale}><Detail /></I18nProvider>)
    fireEvent.click(await screen.findByRole("button", { name: copy.edit }))
    return await screen.findByRole("button", { name: copy.save })
  }

  it("shows readable inline messages instead of raw JSON, and clears each once its field is edited", async () => {
    api.update.mockRejectedValue(new Error(rawJson))
    fireEvent.click(await openEditor())
    expect(await screen.findByText(copy.description)).toBeTruthy()
    expect(screen.getByText(copy.qty)).toBeTruthy()
    expect(screen.getByText(copy.unknown)).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/Too small|Invalid input|"path"|\[\{/)
    fireEvent.change(screen.getByDisplayValue("Work"), { target: { value: "Consulting" } })
    expect(screen.queryByText(copy.description)).toBeNull()
    expect(screen.getByText(copy.qty)).toBeTruthy()
  })

  it("keeps plain-text server messages and uses the save fallback for non-errors", async () => {
    api.update.mockRejectedValueOnce(new Error("Invoice is not editable"))
    fireEvent.click(await openEditor())
    expect((await screen.findByRole("alert")).textContent).toBe("Invoice is not editable")
    api.update.mockRejectedValueOnce("boom")
    fireEvent.click(screen.getByRole("button", { name: copy.save }))
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(copy.failed))
  })
})
