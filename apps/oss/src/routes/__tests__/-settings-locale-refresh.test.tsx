// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  savedLocale: "da",
  distribution: "selfhost",
  getLayout: vi.fn(),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
}))

vi.mock("../../lib/auth-session", () => ({ getAppLayoutSession: state.getLayout }))
vi.mock("../../lib/auth-client", () => ({
  useSession: () => ({ data: { user: { id: "u_1" }, session: { activeOrganizationId: "org_1" } }, isPending: false }),
  authClient: { organization: { getFullOrganization: vi.fn(async () => ({ data: { members: [], invitations: [] } })) } },
}))
vi.mock("../../components/ui/sidebar", () => ({ SidebarProvider: ({ children }: { children: ReactNode }) => children }))
vi.mock("../../components/app-sidebar", async () => {
  const { useI18n } = await import("../../lib/i18n/react")
  return { AppSidebar: () => <nav>{useI18n().t("nav.invoices")}</nav> }
})
vi.mock("../../components/shell/app-main", () => ({ AppMain: ({ children }: { children: ReactNode }) => children }))
vi.mock("../../components/billing/trial-access", () => ({
  TrialAccessProvider: ({ children }: { children: ReactNode }) => children,
  TrialBanner: () => null,
  TrialRouteGate: ({ children }: { children: ReactNode }) => children,
}))
// Native selects drive the same controlled Settings handlers without Radix browser APIs.
vi.mock("../../components/ui/select", () => ({
  Select: ({ value, onValueChange, children }: { value: string; onValueChange: (value: string) => void; children: ReactNode }) => <select value={value} onChange={event => onValueChange(event.target.value)}>{children}</select>,
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: ReactNode }) => children,
  SelectItem: ({ value, children }: { value: string; children: ReactNode }) => <option value={value}>{children}</option>,
}))
vi.mock("../../components/settings/document-email-sending-card", () => ({ DocumentEmailSendingCard: () => null }))
vi.mock("../../components/settings/email-delivery-card", () => ({ EmailDeliveryCard: () => null }))
vi.mock("../../components/settings/payment-details-card", () => ({ PaymentDetailsCard: () => null }))
vi.mock("../../components/settings/reminder-policy-card", () => ({ ReminderPolicyCard: () => null }))
vi.mock("../../components/settings/agent-keys-card", () => ({ AgentKeysCard: () => null }))
vi.mock("../_app/-settings.helpers", () => ({ shouldAutoLoadAiModels: () => false }))
vi.mock("../../trpc/client", () => ({
  trpc: {
    settings: { get: { query: state.getSettings }, update: { mutate: state.updateSettings } },
    runtime: { capabilities: { query: vi.fn(async () => ({
      sellerVatConfirmation: { enabled: false },
      onboardingV2: { nonVatEnabled: true },
      aiInvoiceDraft: { enabled: false },
    })) } },
  },
}))

import { Route as AppRoute } from "../_app"
import { Route as SettingsRoute } from "../_app/settings"
import { I18nProvider, useI18n } from "../../lib/i18n/react"
import { translate } from "../../lib/i18n/translate"
import { invalidateAppLayoutSession } from "../../lib/app-layout-session"
import { getRequestOrganizationId, resetRequestOrganizationForTesting } from "../../lib/active-organization"

function settingsData() {
  return {
    id: "settings_1", countryCode: "US", locale: state.savedLocale, timezone: "UTC",
    baseCurrency: "USD", baseCurrencyLocked: false, defaultCurrency: "USD", currency: "USD",
    taxRegime: "us_sales_tax", pricesIncludeTax: false, taxRate: null, momsRegistered: null,
    paymentTermsDays: 14, companyName: "Acme", companyAddress: "Main St 1",
    companyEmail: "billing@example.test", companyPhone: null, companyLogo: null,
    invoicePrefix: "INV", invoiceNextNum: 1, quotePrefix: "QTE", quoteNextNum: 1,
    creditNotePrefix: "CN", creditNoteNextNum: 1, aiProvider: "openrouter",
    aiBaseUrl: null, aiModel: "openai/gpt-4o-mini", aiByokConfigured: false,
    stripeByokConfigured: false, stripePublishableKey: null,
    primaryTaxId: null, primaryTaxIdScheme: "vat",
    emailDelivery: { managed: false, configured: false, available: false, sender: "", missing: [], status: "missing_configuration" },
    documentSending: { status: "disabled", requestedDomain: null, records: [], failureReason: null, verifiedAt: null, lastSyncedAt: null, lastSyncSource: null, supportsCustomDomain: false, managed: false, senderEmail: "" },
  }
}

function LocaleProbe() {
  return <output data-testid="current-locale">{useI18n().locale}</output>
}

beforeEach(() => {
  vi.stubEnv("SSR", false)
  state.savedLocale = "da"
  state.distribution = "selfhost"
  state.getLayout.mockImplementation(async () => ({
    user: { id: "u_1", name: "User", email: "user@example.test", image: null },
    activeOrganizationId: "org_1", runtime: { distribution: state.distribution, billingEnabled: false },
    locale: state.savedLocale, cloudOnboardingComplete: state.distribution === "cloud" ? true : null,
  }))
  state.getSettings.mockImplementation(async () => settingsData())
  state.updateSettings.mockImplementation(async (input: { locale: string }) => {
    state.savedLocale = input.locale
    return settingsData()
  })
})
afterEach(() => {
  cleanup()
  invalidateAppLayoutSession()
  resetRequestOrganizationForTesting()
  vi.clearAllMocks()
  vi.unstubAllEnvs()
})

async function renderSettings() {
  const root = createRootRoute()
  // Attach the production file routes to a small real router, retaining their loaders and hooks.
  const app = AppRoute.update({ id: "_app", getParentRoute: () => root } as never)
  const settings = SettingsRoute.update({ path: "/settings", getParentRoute: () => app } as never)
  const elsewhere = createRoute({ getParentRoute: () => app, path: "elsewhere", component: LocaleProbe })
  const router = createRouter({
    routeTree: root.addChildren([app.addChildren([settings, elsewhere])]),
    history: createMemoryHistory({ initialEntries: ["/settings"] }),
  })
  await router.load()
  const view = render(<I18nProvider><RouterProvider router={router} /></I18nProvider>)
  await screen.findByRole("button", { name: translate("settings.action.save", state.savedLocale) })
  return { ...view, router }
}

function languageSelect(container: HTMLElement) {
  return Array.from(container.querySelectorAll("select")).find(select =>
    Array.from(select.options).some(option => option.value === "en-US") &&
    Array.from(select.options).some(option => option.value === "da-DK")
  )!
}

function expectLanguage(locale: string) {
  expect(screen.getByRole("navigation").textContent).toBe(translate("nav.invoices", locale))
  expect(screen.getByText(translate("settings.locale.label", locale))).toBeTruthy()
  expect(document.documentElement.lang).toBe(locale.startsWith("da") ? "da" : "en")
  expect(getRequestOrganizationId()).toBe("org_1")
}

describe("saving the Settings language", () => {
  it.each(["da", "en-US"])("switches chrome, form and current route locale in both directions from %s without remounting", async initialLocale => {
    state.savedLocale = initialLocale
    const { container, router } = await renderSettings()
    const navigation = screen.getByRole("navigation")
    expectLanguage(initialLocale)
    let previousLocale = initialLocale
    const targets = initialLocale === "da" ? ["en-US", "da-DK"] : ["da-DK", "en-US"]
    for (const locale of targets) {
      const initialForm = container.querySelector("form")!
      fireEvent.change(languageSelect(container), { target: { value: locale } })
      expectLanguage(previousLocale)
      fireEvent.submit(initialForm)
      await waitFor(() => expectLanguage(locale))
      expect(state.savedLocale).toBe(locale)
      expect(router.state.matches.find(match => match.routeId === "/_app")?.context.locale).toBe(locale)
      expect(router.state.location.pathname).toBe("/settings")
      expect(screen.getByRole("navigation")).toBe(navigation)
      expect(container.querySelector("form")).toBe(initialForm)
      // Ordinary navigation during the five-second reuse window must keep the saved locale.
      await act(async () => { await router.navigate({ to: "/elsewhere" } as never) })
      expect(screen.getByTestId("current-locale").textContent).toBe(locale)
      expect(screen.getByRole("navigation")).toBe(navigation)
      await act(async () => { await router.navigate({ to: "/settings" }) })
      await screen.findByRole("button", { name: translate("settings.action.save", locale) })
      previousLocale = locale
    }
  })

  it("preserves edits made after saving without reinitializing the form", async () => {
    const { container } = await renderSettings()
    let finishReload!: (data: ReturnType<typeof settingsData>) => void
    const reload = new Promise<ReturnType<typeof settingsData>>(resolve => { finishReload = resolve })
    state.getSettings.mockImplementation(() => reload)
    fireEvent.change(languageSelect(container), { target: { value: "en-US" } })
    fireEvent.submit(container.querySelector("form")!)
    await screen.findByText(translate("settings.success.saved", "en-US"))
    fireEvent.change(languageSelect(container), { target: { value: "da-DK" } })
    await act(async () => { finishReload(settingsData()) })
    expect(languageSelect(container).value).toBe("da-DK")
    expect(state.getSettings).toHaveBeenCalledTimes(1)
  })

  it.each(["selfhost", "cloud"])("keeps this tab's organization context when another tab switches organization on %s", async distribution => {
    state.distribution = distribution
    const { container, router } = await renderSettings()
    const originalContext = router.state.matches.find(match => match.routeId === "/_app")!.context
    state.getLayout.mockResolvedValue({ ...originalContext, activeOrganizationId: "org_2", locale: "da" })
    fireEvent.change(languageSelect(container), { target: { value: "en-US" } })
    fireEvent.submit(container.querySelector("form")!)
    await screen.findByText(translate("settings.success.saved", "en-US"))
    await waitFor(() => expectLanguage("en-US"))
    expect(router.state.matches.find(match => match.routeId === "/_app")?.context)
      .toEqual(expect.objectContaining({ activeOrganizationId: "org_1", locale: "en-US" }))
    expect(state.getLayout).toHaveBeenCalledTimes(1)
    await act(async () => { await router.navigate({ to: "/elsewhere" } as never) })
    expect(screen.getByTestId("current-locale").textContent).toBe("en-US")
    expect(getRequestOrganizationId()).toBe("org_1")
  })

  it.each(["selfhost", "cloud"])("preserves the working route and saved state when the layout endpoint is unavailable on %s", async distribution => {
    state.distribution = distribution
    const { container, router } = await renderSettings()
    const form = container.querySelector("form")!
    state.getLayout.mockRejectedValue(new Error("Layout unavailable"))
    fireEvent.change(languageSelect(container), { target: { value: "en-US" } })
    fireEvent.submit(form)
    await screen.findByText(translate("settings.success.saved", "en-US"))
    await waitFor(() => expectLanguage("en-US"))
    expect(container.querySelector("form")).toBe(form)
    expect(router.state.matches.every(match => match.status === "success")).toBe(true)
    expect(state.savedLocale).toBe("en-US")
    expect(state.getLayout).toHaveBeenCalledTimes(1)
  })

  it("keeps the visible and route language while saving and after a rejected save", async () => {
    const { container, router } = await renderSettings()
    let reject!: (error: Error) => void
    state.updateSettings.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
    fireEvent.change(languageSelect(container), { target: { value: "en-US" } })
    expectLanguage("da")
    fireEvent.submit(container.querySelector("form")!)
    await waitFor(() => expect(state.updateSettings).toHaveBeenCalledWith(expect.objectContaining({ locale: "en-US" })))
    expectLanguage("da")
    await act(async () => reject(new Error("Save rejected")))
    expect(await screen.findByText("Save rejected")).toBeTruthy()
    expectLanguage("da")
    expect(router.state.matches.find(match => match.routeId === "/_app")?.context.locale).toBe("da")
    expect(state.getLayout).toHaveBeenCalledTimes(1)
    expect(state.savedLocale).toBe("da")
  })
})
