// @vitest-environment jsdom
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { I18nProvider } from "../../lib/i18n/react"
// MOCK: transport responses and route context only. The detail page, send handler,
// bank hook and dialog are real; no email provider or network is used.
const api = vi.hoisted(() => ({ get: vi.fn(), settings: vi.fn(), readiness: vi.fn(), send: vi.fn(), sendReadiness: vi.fn(), navigate: vi.fn() }))
vi.mock("../../trpc/client", () => ({ trpc: {
  invoices: { get: { query: api.get }, sendReadiness: { query: api.sendReadiness }, send: { mutate: api.send } }, settings: { get: { query: api.settings } },
  paymentDetails: { firstSendReadiness: { query: api.readiness } },
} }))
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: object) => ({ ...options, useParams: () => ({ invoiceId: "draft" }), useSearch: () => ({}) }),
  useNavigate: () => api.navigate,
  Link: ({ children, to, onClick, ...props }: { children: ReactNode; to: string; onClick?: () => void }) => <a href={to} {...props} onClick={event => { event.preventDefault(); onClick?.(); api.navigate({ to }) }}>{children}</a>,
}))
vi.mock("../../components/billing/trial-access", () => ({ useTrialAccess: () => null, isReadOnly: () => false, PaywallBlock: () => null }))
vi.mock("../../components/invoices/panels", () => ({ InvoiceLifecyclePanels: () => null }))
import { Route } from "../_app/invoices/$invoiceId"
const Detail = (Route as unknown as { component: () => ReactNode }).component
const draft = {
  reviewedVersion: "11111111111111111111111111111111",
  id: "draft", number: null, status: "draft", paymentStatus: "unpaid", purpose: "sale", currency: "DKK", taxRegime: "eu_vat",
  dueDate: "2026-11-09", issueDate: "2026-10-13", supplyDate: "2026-10-13", items: [], total: 0, subtotal: 0, taxAmount: 0,
  contact: { id: "buyer", name: "Synthetic buyer", email: "buyer@example.test" }, sellerSnapshot: { countryCode: "DK", momsRegistered: false },
}
beforeEach(() => {
  vi.resetAllMocks()
  api.get.mockResolvedValue(draft)
  api.settings.mockResolvedValue({ locale: "en-GB", baseCurrency: "DKK", emailDelivery: { available: true } })
  api.send.mockResolvedValue({})
  api.sendReadiness.mockResolvedValue({ issues: [], baseCurrency: "DKK" })
})
afterEach(cleanup)
async function open() {
  render(<I18nProvider locale="en-GB"><Detail /></I18nProvider>)
  return await screen.findByRole("button", { name: "Send" }) as HTMLButtonElement
}
async function confirmSend(send: HTMLButtonElement) {
  fireEvent.click(send)
  fireEvent.click(await screen.findByRole("button", { name: "Send invoice" }))
}
describe("invoice view-mode bank nudge", () => {
  it("surfaces the server bank block after continuing without bank or Stripe", async () => {
    api.readiness.mockResolvedValue({ bankMissing: true })
    api.send.mockRejectedValueOnce(Object.assign(new Error("Missing payment method"), { data: { fieldIssues: [{ code: "seller.bank.required", field: "seller.bankAccount", params: {} }] } }))
    const send = await open()
    await confirmSend(send)
    await screen.findByRole("dialog")
    expect(send.disabled).toBe(true)
    expect(api.send).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Send without a bank account" }))
    await waitFor(() => expect(api.send).toHaveBeenCalledOnce())
    await waitFor(() => expect(send.disabled).toBe(false))
    expect(screen.getByTestId("organization-gaps")).toBeTruthy()
    // MOCK: the user has added bank details through Settings before retrying.
    api.readiness.mockResolvedValue({ bankMissing: false })
    await confirmSend(send)
    await waitFor(() => expect(api.send).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByTestId("organization-gaps")).toBeNull())
  })
  it("cancels without sending and permits another attempt", async () => {
    api.readiness.mockResolvedValue({ bankMissing: true })
    const send = await open()
    await confirmSend(send)
    fireEvent.keyDown(await screen.findByRole("dialog"), { key: "Escape" })
    await waitFor(() => expect(send.disabled).toBe(false))
    expect(api.send).not.toHaveBeenCalled()
    await confirmSend(send)
    await screen.findByRole("dialog")
  })
  it("sends after bank details are configured without a nudge", async () => {
    api.readiness.mockResolvedValue({ bankMissing: false })
    const send = await open()
    await confirmSend(send)
    await waitFor(() => expect(api.send).toHaveBeenCalledOnce())
    await waitFor(() => expect(send.disabled).toBe(false))
    expect(screen.queryByRole("dialog")).toBeNull()
  })
})

describe("invoice payment-link availability", () => {
  it.each([[true, false], [false, true]])("uses checkout readiness=%s with saved BYOK=%s", async (ready, byok) => {
    api.get.mockResolvedValue({ ...draft, number: "INV-1", status: "sent", total: 100, balanceDue: 100, amountPaid: 0, amountCredited: 0 })
    api.settings.mockResolvedValue({ locale: "en-GB", stripePaymentsEnabled: ready, stripeByokConfigured: byok })
    render(<I18nProvider locale="en-GB"><Detail /></I18nProvider>)
    await screen.findByRole("button", { name: "Mark as Paid" })
    expect(screen.queryByRole("button", { name: "Create Payment Link" }) !== null).toBe(ready)
  })

  it.each([
    ["en-GB", "Payment links are unavailable right now. Check your Stripe settings."],
    ["da-DK", "Betalingslink er ikke tilgængelige lige nu. Tjek dine Stripe-indstillinger."],
  ])("explains the missing payment link when checkout cannot be resolved (%s)", async (locale, hint) => {
    api.get.mockResolvedValue({ ...draft, number: "INV-1", status: "sent", total: 100, balanceDue: 100, amountPaid: 0, amountCredited: 0 })
    api.settings.mockResolvedValue({ locale, stripePaymentsEnabled: false, stripeCheckoutUnavailable: true })
    render(<I18nProvider locale={locale}><Detail /></I18nProvider>)
    expect(await screen.findByText(hint)).toBeTruthy()
    expect(screen.queryByRole("button", { name: /payment link|betalingslink/i })).toBeNull()
  })

  it("shows no hint when payments are not set up or the link is available", async () => {
    api.get.mockResolvedValue({ ...draft, number: "INV-1", status: "sent", total: 100, balanceDue: 100, amountPaid: 0, amountCredited: 0 })
    api.settings.mockResolvedValue({ locale: "en-GB", stripePaymentsEnabled: false, stripeCheckoutUnavailable: false })
    render(<I18nProvider locale="en-GB"><Detail /></I18nProvider>)
    await screen.findByRole("button", { name: "Mark as Paid" })
    expect(screen.queryByTestId("payment-link-unavailable")).toBeNull()
  })
})
