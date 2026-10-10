// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { I18nProvider } from "../../lib/i18n/react"

const state = vi.hoisted(() => ({
  subscription: { status: "canceled", priceId: null, access: { paidOnly: true, hasSubscription: false, checkoutAvailable: true, portalAvailable: false } } as unknown,
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
import { Route } from "../_app/billing"
const BillingPage = Route.options.component!

afterEach(() => { cleanup(); vi.clearAllMocks(); state.billingEnabled = true })

describe("billing presentation follows server state", () => {
  it.each(["en-US", "da-DK"])("has no free offer or URL-based activation for unpaid paid-only access in %s", async locale => {
    state.subscription = { status: "canceled", priceId: null, access: { paidOnly: true, hasSubscription: false, checkoutAvailable: true, portalAvailable: false } }
    render(<I18nProvider locale={locale}><BillingPage /></I18nProvider>)
    const button = await screen.findByRole("button", { name: locale === "da-DK" ? "Opgrader" : "Upgrade" })
    expect(screen.queryByText(/5 (invoices|fakturaer)/)).toBeNull()
    expect(screen.queryByText(/activated successfully|blev aktiveret/)).toBeNull()
    fireEvent.click(button)
    expect(state.checkout).toHaveBeenCalledOnce()
  })

  it("offers recovery for a current past-due subscription without creating another subscription", async () => {
    state.subscription = { status: "past_due", priceId: "synthetic", access: { paidOnly: true, hasSubscription: true, checkoutAvailable: false, portalAvailable: true } }
    render(<I18nProvider locale="en-US"><BillingPage /></I18nProvider>)
    fireEvent.click(await screen.findByRole("button", { name: "Manage Subscription" }))
    expect(state.portal).toHaveBeenCalledOnce()
    expect(screen.queryByRole("button", { name: "Upgrade" })).toBeNull()
  })

  it("shows activation only when server subscription is active", async () => {
    state.subscription = { status: "active", priceId: "synthetic", access: { paidOnly: true, hasSubscription: true, checkoutAvailable: false, portalAvailable: true } }
    render(<I18nProvider locale="en-US"><BillingPage /></I18nProvider>)
    expect(await screen.findByText("Subscription activated successfully.")).toBeTruthy()
  })

  it("keeps self-host billing unchanged without requesting hosted billing", async () => {
    state.billingEnabled = false
    render(<I18nProvider locale="en-US"><BillingPage /></I18nProvider>)
    expect(await screen.findByText("Self-host billing")).toBeTruthy()
    expect(screen.queryByRole("button")).toBeNull()
  })
})
