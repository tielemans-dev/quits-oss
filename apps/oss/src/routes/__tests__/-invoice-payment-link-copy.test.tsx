// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import type { ComponentType, ReactNode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
const mock = vi.hoisted(() => ({ settings: vi.fn() }))
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ ...options as object, useParams: () => ({ invoiceId: "synthetic" }), useSearch: () => ({}) }),
  useNavigate: () => vi.fn(), Link: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}))
vi.mock("../../trpc/client", () => ({ trpc: { settings: { get: { query: mock.settings } }, invoices: { get: { query: async () => ({
  id: "synthetic", number: "INV-1", status: "sent", purpose: "sale", paymentStatus: "unpaid", currency: "DKK", pricesIncludeTax: false,
  issueDate: "2026-10-12", dueDate: "2026-11-12", items: [], contact: { name: "Synthetic Buyer", email: "buyer@example.test" },
  subtotalNet: 100, totalTax: 25, totalGross: 125, amountPaid: 0, publicPaymentUrl: "https://example.test/pay/frozen-link",
}) } } } }))
vi.mock("../../components/billing/trial-access", () => ({ useTrialAccess: () => null, isReadOnly: () => false, PaywallBlock: () => null }))
vi.mock("../../hooks/use-poll-while", () => ({ usePollWhile: () => {} }))
vi.mock("../../components/invoices/panels", () => ({ InvoiceLifecyclePanels: () => null }))
import { Route } from "../_app/invoices/$invoiceId"
import { I18nProvider } from "../../lib/i18n/react"
const Page = (Route as unknown as { component: ComponentType }).component
afterEach(cleanup)
describe("customer payment link wording", () => {
  it.each([
    ["da-DK", false, "Kunden kan se fakturaen og dine bankoplysninger via linket."],
    ["en-US", false, "Your customer can see the invoice and your bank details via the link."],
    ["da-DK", true, "Del dette hostede link med kunden for at modtage betaling via Stripe."],
    ["en-US", true, "Share this hosted link with the customer to collect payment through Stripe."],
  ])("uses %s copy for actual Stripe configuration %s", async (locale, configured, expected) => {
    mock.settings.mockResolvedValue({ stripeByokConfigured: configured, companyName: "Synthetic Seller" })
    render(<I18nProvider locale={locale}><Page /></I18nProvider>)
    expect((await screen.findByText(expected)).textContent).toBe(expected)
    if (!configured) expect(screen.queryByText(/via Stripe|through Stripe/)).toBeNull()
    expect(screen.getByDisplayValue("https://example.test/pay/frozen-link")).toBeTruthy()
  })
})
