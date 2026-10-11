// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import { I18nProvider } from "../../../lib/i18n/react"
import type { BillingSubscription } from "../../../lib/billing/types"

const state = vi.hoisted(() => ({ subscription: null as BillingSubscription | null }))
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, ...props }: { children: React.ReactNode; to: string }) => <a href={to} {...props}>{children}</a>,
}))
vi.mock("../../../lib/runtime-distribution", () => ({ useRuntimeDistribution: () => ({ billingEnabled: true }) }))
vi.mock("../../../trpc/client", () => ({ trpc: { billing: { getSubscription: { query: async () => state.subscription } } } }))

import { blockedResource, PaywallBlock, TrialAccessProvider, TrialBanner, TrialRouteGate } from "../trial-access"

afterEach(() => { cleanup(); state.subscription = null })

describe("trial form gate", () => {
  it("keeps complimentary access writable without a trial banner despite API trial dates", async () => {
    state.subscription = { status: "active", priceId: null,
      trialStart: Date.UTC(2026, 9, 1) / 1000, trialEnd: Date.UTC(2026, 9, 25) / 1000,
      access: { paidOnly: true, hasSubscription: false, checkoutAvailable: false, portalAvailable: false } }
    render(<I18nProvider locale="en-US"><TrialAccessProvider>
      <TrialBanner />
      <TrialRouteGate pathname="/invoices/new"><form aria-label="invoice form"><input /></form></TrialRouteGate>
    </TrialAccessProvider></I18nProvider>)
    expect(await screen.findByRole("form", { name: "invoice form" })).toBeTruthy()
    expect(screen.queryByRole("complementary")).toBeNull()
    expect(screen.queryByRole("progressbar")).toBeNull()
    expect(screen.queryByText(/trial/i)).toBeNull()
  })

  it.each([
    ["da-DK", "Din prøveperiode er slut. Dine data er gemt, og du kan stadig se og downloade alt."],
    ["en-US", "Your trial has ended. Your data is safe, and you can still view and download everything."],
  ])("shows the %s paywall without an empty date when the end date is missing", (locale, body) => {
    for (const endDate of [undefined, null]) {
      render(<I18nProvider locale={locale}><PaywallBlock resource="invoices" endDate={endDate} /></I18nProvider>)
      expect(screen.getByText(body)).toBeTruthy()
      cleanup()
    }
  })

  it("shows the localized paywall before any expired-trial form is rendered", async () => {
    state.subscription = { status: "expired", priceId: "price_synthetic", trialEnd: Date.UTC(2026, 9, 25) / 1000,
      access: { paidOnly: true, hasSubscription: true, checkoutAvailable: false, portalAvailable: true } }
    render(<I18nProvider locale="da-DK"><TrialAccessProvider>
      <TrialRouteGate pathname="/invoices/new"><form aria-label="invoice form"><input /></form></TrialRouteGate>
    </TrialAccessProvider></I18nProvider>)
    expect(screen.queryByRole("form", { name: "invoice form" })).toBeNull()
    expect(await screen.findByRole("heading", { name: "Opgrader for at oprette fakturaer" })).toBeTruthy()
    expect(screen.queryByRole("form", { name: "invoice form" })).toBeNull()
    expect(screen.getByText(/25\. oktober 2026/)).toBeTruthy()
  })

  it("allows a trial form and leaves read routes available", async () => {
    state.subscription = { status: "trialing", priceId: "price_synthetic", trialEnd: Date.UTC(2026, 9, 25) / 1000,
      access: { paidOnly: true, hasSubscription: true, checkoutAvailable: false, portalAvailable: true } }
    render(<I18nProvider locale="en-US"><TrialAccessProvider>
      <TrialRouteGate pathname="/contacts/new"><form aria-label="customer form"><input /></form></TrialRouteGate>
    </TrialAccessProvider></I18nProvider>)
    expect(await screen.findByRole("form", { name: "customer form" })).toBeTruthy()
    expect(blockedResource("/invoices/issued-id")).toBeNull()
    expect(blockedResource("/contacts/customer-id")).toBe("contacts")
    expect(blockedResource("/agreements/draft-id/edit")).toBe("agreements")
  })
})
