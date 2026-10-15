// @vitest-environment jsdom
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { I18nProvider } from "../../lib/i18n/react"
// MOCK: transport responses and route context only. The detail page, send handler,
// bank hook and dialog are real; no email provider or network is used.
const api = vi.hoisted(() => ({ get: vi.fn(), settings: vi.fn(), readiness: vi.fn(), send: vi.fn() }))
vi.mock("../../trpc/client", () => ({ trpc: {
  invoices: { get: { query: api.get }, sendReadiness: { query: async () => ({ issues: [], baseCurrency: "DKK" }) }, send: { mutate: api.send } }, settings: { get: { query: api.settings } },
  paymentDetails: { firstSendReadiness: { query: api.readiness } },
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
  dueDate: "2026-11-09", issueDate: "2026-10-13", supplyDate: "2026-10-13", items: [], total: 0, subtotal: 0, taxAmount: 0,
  contact: { id: "buyer", name: "Synthetic buyer", email: "buyer@example.test" }, sellerSnapshot: { countryCode: "DK", momsRegistered: false },
}
beforeEach(() => {
  vi.resetAllMocks()
  api.get.mockResolvedValue(draft)
  api.settings.mockResolvedValue({ locale: "en-GB", baseCurrency: "DKK", emailDelivery: { available: true } })
  api.send.mockResolvedValue({})
})
afterEach(cleanup)
async function open() {
  render(<I18nProvider locale="en-GB"><Detail /></I18nProvider>)
  return await screen.findByRole("button", { name: "Send" }) as HTMLButtonElement
}
describe("invoice view-mode bank nudge", () => {
  it("proceeds after explicit skip and clears acting after sending", async () => {
    api.readiness.mockResolvedValue({ bankMissing: true })
    const send = await open()
    fireEvent.click(send)
    await screen.findByRole("dialog")
    expect(send.disabled).toBe(true)
    expect(api.send).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Send without a bank account" }))
    await waitFor(() => expect(api.send).toHaveBeenCalledOnce())
    await waitFor(() => expect(send.disabled).toBe(false))
  })
  it("cancels without sending and permits another attempt", async () => {
    api.readiness.mockResolvedValue({ bankMissing: true })
    const send = await open()
    fireEvent.click(send)
    fireEvent.keyDown(await screen.findByRole("dialog"), { key: "Escape" })
    await waitFor(() => expect(send.disabled).toBe(false))
    expect(api.send).not.toHaveBeenCalled()
    fireEvent.click(send)
    await screen.findByRole("dialog")
  })
  it("does not gate the self-hosted readiness result", async () => {
    api.readiness.mockResolvedValue({ bankMissing: false })
    const send = await open()
    fireEvent.click(send)
    await waitFor(() => expect(api.send).toHaveBeenCalledOnce())
    await waitFor(() => expect(send.disabled).toBe(false))
    expect(screen.queryByRole("dialog")).toBeNull()
  })
})
