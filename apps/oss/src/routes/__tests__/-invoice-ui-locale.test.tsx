// @vitest-environment jsdom
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { I18nProvider } from "../../lib/i18n/react"
// MOCK: transport responses and route context only. The detail page and its payment block are real.
const api = vi.hoisted(() => ({ get: vi.fn(), settings: vi.fn(), readiness: vi.fn(), sendReadiness: vi.fn(), panelLocale: vi.fn() }))
vi.mock("../../trpc/client", () => ({ trpc: {
  invoices: { get: { query: api.get }, sendReadiness: { query: api.sendReadiness } }, settings: { get: { query: api.settings } },
  paymentDetails: { firstSendReadiness: { query: api.readiness } },
} }))
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: object) => ({ ...options, useParams: () => ({ invoiceId: "sent" }), useSearch: () => ({}) }),
  useNavigate: () => vi.fn(),
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}))
vi.mock("../../components/billing/trial-access", () => ({ useTrialAccess: () => null, isReadOnly: () => false, PaywallBlock: () => null }))
vi.mock("../../components/invoices/panels", () => ({ InvoiceLifecyclePanels: ({ locale }: { locale?: string }) => { api.panelLocale(locale); return null } }))
import { Route } from "../_app/invoices/$invoiceId"
const Detail = (Route as unknown as { component: () => ReactNode }).component

// MOCK: a synthetic issued Danish invoice with an outstanding balance.
const sent = {
  reviewedVersion: "11111111111111111111111111111111",
  id: "sent", number: "INV-0042", paymentReference: null, status: "sent", paymentStatus: "unpaid", purpose: "sale", currency: "DKK", taxRegime: "eu_vat",
  momsRegistered: true, dueDate: "2026-11-09", issueDate: "2026-10-13", supplyDate: "2026-10-13", paidAt: null,
  items: [{ id: "line", description: "Consulting", quantity: 1, unitPrice: 18000, total: 18000, taxRate: 25, sortOrder: 0 }],
  subtotal: 18000, taxAmount: 4500, total: 22500, amountPaid: 0, amountCredited: 0, balanceDue: 22500, notes: null, publicPaymentUrl: null,
  lastEmailAttemptAt: null, lastEmailAttemptOutcome: null, lastEmailAttemptCode: null, lastEmailAttemptMessage: null,
  countryCode: "DK", contact: { id: "buyer", name: "Synthetic buyer", email: "buyer@example.test" },
  sellerSnapshot: {
    companyName: "Synthetic Seller ApS", countryCode: "DK", momsRegistered: true,
    taxIds: [{ scheme: "cvr", countryCode: "DK", value: "12345678" }],
    bankAccount: { regNumber: "0040", accountNumber: "0440116243" },
  },
}

beforeEach(() => {
  vi.resetAllMocks()
  api.get.mockResolvedValue(sent)
  // The organization writes Danish documents; the person reads the app in English.
  api.settings.mockResolvedValue({ locale: "da-DK", timezone: "Europe/Copenhagen", baseCurrency: "DKK", emailDelivery: { available: true } })
  api.sendReadiness.mockResolvedValue({ issues: [], baseCurrency: "DKK" })
  api.readiness.mockResolvedValue({ bankMissing: false })
})
afterEach(cleanup)

describe("invoice page with an English interface on a Danish organization", () => {
  it("shows the payment block, labels, panels and dates in en-US", async () => {
    const { container } = render(<I18nProvider locale="en-US"><Detail /></I18nProvider>)
    const block = await screen.findByRole("region", { name: "How to pay" })
    expect(block.textContent).toMatch(/DKK\s22,500\.00/)
    expect(block.textContent).toContain("9 Nov 2026")
    expect(container.textContent).toContain("CVR no. 12345678")
    expect(container.textContent).toContain("25 % VAT")
    expect(container.textContent).not.toMatch(/kr\.|moms|CVR-nr\./)
    await waitFor(() => expect(api.panelLocale).toHaveBeenLastCalledWith("en-US"))
  })
})
