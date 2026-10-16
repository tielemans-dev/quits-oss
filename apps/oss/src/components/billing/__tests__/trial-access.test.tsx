// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render, screen } from "@testing-library/react"
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
  it.each(["da-DK", "en-US"])("uses the read-only reason for the banner and form gate in %s", async locale => {
    for (const reason of ["trial_ended", "payment_failed", "canceled"] as const) {
      state.subscription = { status: "expired", priceId: null,
        organizationAccess: { state: "read_only", reason, trialEnd: 1 } }
      render(<I18nProvider locale={locale}><TrialAccessProvider><TrialBanner />
        <TrialRouteGate pathname="/invoices/new"><form aria-label="invoice form" /></TrialRouteGate>
      </TrialAccessProvider></I18nProvider>)
      const title = reason === "trial_ended"
        ? locale === "da-DK" ? "Din prøveperiode er slut" : "Your trial has ended"
        : locale === "da-DK" ? "Din organisation er skrivebeskyttet" : "Your organization is read-only"
      expect((await screen.findAllByText(title)).length).toBeGreaterThan(0)
      expect(screen.queryByRole("form")).toBeNull()
      expect(screen.queryByRole("progressbar")).toBeNull()
      expect(Boolean(screen.queryAllByText(/prøveperiode|trial/i).length)).toBe(reason === "trial_ended")
      if (reason !== "trial_ended") {
        const action = locale === "da-DK" ? "Gå til abonnement" : "Go to billing"
        expect(screen.getAllByRole("link", { name: action }).every(link => link.getAttribute("href") === "/billing")).toBe(true)
      }
      cleanup()
    }
  })

  it("uses the server trial decision even when the browser clock says it expired", async () => {
    state.subscription = { status: "expired", priceId: null, trialEnd: 1,
      organizationAccess: { state: "trial", daysLeft: 14, trialStart: 1, trialEnd: 2, progress: 0 },
      access: { paidOnly: true, hasSubscription: false, checkoutAvailable: true, portalAvailable: false } } as BillingSubscription
    render(<I18nProvider locale="en-US"><TrialAccessProvider>
      <TrialBanner /><TrialRouteGate pathname="/invoices/new"><form aria-label="invoice form" /></TrialRouteGate>
    </TrialAccessProvider></I18nProvider>)
    expect(await screen.findByRole("form", { name: "invoice form" })).toBeTruthy()
    expect(screen.getByText(/14 days/)).toBeTruthy()
    expect(screen.queryByText("Trial ended")).toBeNull()
  })

  it("refreshes trial expiry, payment and cancellation from the server", async () => {
    const initial = { status: "active" as const, priceId: null, organizationAccess: { state: "trial" as const, daysLeft: 14, trialStart: 1, trialEnd: 2, progress: 0 } }
    state.subscription = initial
    render(<I18nProvider locale="en-US"><TrialAccessProvider><TrialBanner />
      <TrialRouteGate pathname="/invoices/new"><form aria-label="invoice form" /></TrialRouteGate>
    </TrialAccessProvider></I18nProvider>)
    expect(await screen.findByRole("form")).toBeTruthy()
    for (const next of ["read_only", "subscribed", "read_only", "complimentary", "self_hosted"] as const) {
      state.subscription = { ...initial, organizationAccess: next === "read_only" ? { state: next, reason: "trial_ended" } : { state: next } }
      await act(async () => { window.dispatchEvent(new Event("focus")) })
      expect(Boolean(screen.queryByRole("form"))).toBe(next !== "read_only")
      expect(Boolean(screen.queryByText("Trial ended"))).toBe(next === "read_only")
    }
  })

  it("keeps complimentary access writable without a trial banner despite API trial dates", async () => {
    state.subscription = { status: "active", organizationAccess: { state: "complimentary" }, priceId: null,
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
      render(<I18nProvider locale={locale}><PaywallBlock resource="invoices" access={{ state: "read_only", reason: "trial_ended", trialEnd: endDate }} /></I18nProvider>)
      expect(screen.getByText(body)).toBeTruthy()
      cleanup()
    }
  })

  it("shows the localized paywall before any expired-trial form is rendered", async () => {
    state.subscription = { status: "expired", organizationAccess: { state: "read_only", reason: "trial_ended", trialEnd: Date.UTC(2026, 9, 25) / 1000 }, priceId: "price_synthetic", trialEnd: Date.UTC(2026, 9, 25) / 1000,
      access: { paidOnly: true, hasSubscription: true, checkoutAvailable: false, portalAvailable: true } }
    render(<I18nProvider locale="da-DK"><TrialAccessProvider>
      <TrialRouteGate pathname="/invoices/new"><form aria-label="invoice form"><input /></form></TrialRouteGate>
    </TrialAccessProvider></I18nProvider>)
    expect(screen.queryByRole("form", { name: "invoice form" })).toBeNull()
    expect(await screen.findByRole("heading", { name: "Opgrader for at oprette fakturaer" })).toBeTruthy()
    expect(screen.queryByRole("form", { name: "invoice form" })).toBeNull()
    expect(screen.getByText(/25\. okt\. 2026/)).toBeTruthy()
  })

  it("allows a trial form and leaves read routes available", async () => {
    state.subscription = { status: "trialing", organizationAccess: { state: "trial", daysLeft: 14, trialStart: 1, trialEnd: 2, progress: 0 }, priceId: "price_synthetic", trialEnd: Date.UTC(2026, 9, 25) / 1000,
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
