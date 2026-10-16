// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { I18nProvider } from "../../lib/i18n/react"

const state = vi.hoisted(() => ({
  subscription: { status: "canceled", organizationAccess: { state: "read_only", trialEnd: Date.UTC(2026, 9, 25) / 1000 }, priceId: null, access: { paidOnly: true, hasSubscription: false, checkoutAvailable: true, portalAvailable: false } } as unknown,
  billingEnabled: true,
  checkout: vi.fn(async () => ({ url: null })), portal: vi.fn(async () => ({ url: null })),
}))
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options }), useSearch: () => ({ success: true }),
}))
vi.mock("../../lib/runtime-distribution", () => ({ useRuntimeDistribution: () => ({ billingEnabled: state.billingEnabled }) }))
vi.mock("../../trpc/client", () => ({ trpc: { billing: {
  getSubscription: { query: async () => state.subscription },
  createCheckoutSession: { mutate: state.checkout }, createPortalSession: { mutate: state.portal },
} } }))
import { TrialAccessProvider } from "../../components/billing/trial-access"
import { Route } from "../_app/billing"
const BillingPage = Route.options.component!

afterEach(() => { cleanup(); vi.clearAllMocks(); state.billingEnabled = true })

describe("billing presentation follows server state", () => {
  it.each([
    ["da-DK", "Aktiv · gratis adgang", "Nuværende plan"],
    ["en-US", "Active · complimentary access", "Current Plan"],
  ])("shows complimentary access without payment or trial details in %s", async (locale, status, currentPlan) => {
    state.subscription = {
      status: "active", organizationAccess: { state: "complimentary" }, priceId: null,
      trialStart: Date.UTC(2026, 9, 1) / 1000, trialEnd: Date.UTC(2026, 9, 25) / 1000,
      renewalDate: Date.UTC(2026, 10, 25) / 1000,
      paymentMethod: { brand: "visa", last4: "4242" },
      plan: { name: "quits", unitAmount: 9900, currency: "dkk", interval: "month", taxBehavior: "exclusive" },
      access: { paidOnly: true, hasSubscription: false, checkoutAvailable: false, portalAvailable: false },
    }
    render(<I18nProvider locale={locale}><TrialAccessProvider><BillingPage /></TrialAccessProvider></I18nProvider>)
    expect(await screen.findByText(status)).toBeTruthy()
    expect(screen.getByText(currentPlan)).toBeTruthy()
    expect(screen.getAllByRole("heading", { name: "quits" })).toHaveLength(1)
    expect(screen.queryByRole("progressbar")).toBeNull()
    expect(screen.queryByRole("button")).toBeNull()
    expect(screen.queryByText(/trial|prøveperiode|renews|fornyes|4242|Betalt|Paid|99/i)).toBeNull()
  })

  it.each(["en-US", "da-DK"])("has no free offer or URL-based activation for unpaid paid-only access in %s", async locale => {
    state.subscription = { status: "canceled", organizationAccess: { state: "read_only", trialEnd: Date.UTC(2026, 9, 25) / 1000 }, priceId: null, access: { paidOnly: true, hasSubscription: false, checkoutAvailable: true, portalAvailable: false } }
    render(<I18nProvider locale={locale}><TrialAccessProvider><BillingPage /></TrialAccessProvider></I18nProvider>)
    const button = await screen.findByRole("button", { name: locale === "da-DK" ? "Opgrader nu" : "Upgrade now" })
    expect(screen.queryByText(/5 (invoices|fakturaer)/)).toBeNull()
    expect(screen.queryByText(/activated successfully|blev aktiveret/)).toBeNull()
    fireEvent.click(button)
    expect(state.checkout).toHaveBeenCalledOnce()
  })

  it("offers recovery for a current past-due subscription without creating another subscription", async () => {
    state.subscription = { status: "past_due", organizationAccess: { state: "read_only", trialEnd: Date.UTC(2026, 9, 25) / 1000 }, priceId: "synthetic", access: { paidOnly: true, hasSubscription: true, checkoutAvailable: false, portalAvailable: true } }
    render(<I18nProvider locale="en-US"><TrialAccessProvider><BillingPage /></TrialAccessProvider></I18nProvider>)
    fireEvent.click(await screen.findByRole("button", { name: "Manage payment" }))
    expect(state.portal).toHaveBeenCalledOnce()
    expect(screen.queryByRole("button", { name: "Upgrade now" })).toBeNull()
  })

  it("shows activation only when server subscription is active", async () => {
    state.subscription = { status: "active", organizationAccess: { state: "subscribed" }, priceId: "synthetic", access: { paidOnly: true, hasSubscription: true, checkoutAvailable: false, portalAvailable: true } }
    render(<I18nProvider locale="en-US"><TrialAccessProvider><BillingPage /></TrialAccessProvider></I18nProvider>)
    expect(await screen.findByText("Subscription activated successfully.")).toBeTruthy()
  })

  it("keeps self-host billing unchanged without requesting hosted billing", async () => {
    state.billingEnabled = false
    render(<I18nProvider locale="en-US"><TrialAccessProvider><BillingPage /></TrialAccessProvider></I18nProvider>)
    expect(await screen.findByText("Self-host billing")).toBeTruthy()
    expect(screen.queryByRole("button")).toBeNull()
  })
})
