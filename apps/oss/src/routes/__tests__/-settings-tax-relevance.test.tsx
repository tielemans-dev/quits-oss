// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ComponentType } from "react"
import { afterEach as afterEachTest, describe, expect, it, vi } from "vitest"

const {
  useSessionMock,
  settingsGetQuery,
  getFullOrganization,
  settingsUpdate,
  runtimeState,
} = vi.hoisted(() => ({
  useSessionMock: vi.fn(),
  settingsGetQuery: vi.fn(),
  getFullOrganization: vi.fn(),
  settingsUpdate: vi.fn(),
  runtimeState: { selfhost: true, nonVatEnabled: true },
}))

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({ ...options }),
}))

vi.mock("../../components/settings/document-email-sending-card", () => ({
  DocumentEmailSendingCard: () => <div>document-sending-card</div>,
}))

vi.mock("../../components/settings/email-delivery-card", () => ({
  EmailDeliveryCard: () => <div>email-delivery-card</div>,
}))

vi.mock("../../lib/i18n/react", () => {
  const i18n = {
    t: (key: string) =>
      (
        {
          "settings.error.loadFailed": "load failed",
          "settings.section.company.title": "Company",
          "settings.section.company.description": "Company description",
          "settings.section.localization.title": "Localization",
          "settings.section.localization.description": "Localization description",
          "settings.section.billingDefaults.title": "Billing defaults",
          "settings.section.billingDefaults.description": "Billing defaults description",
          "settings.country.label": "Country",
          "settings.country.placeholder": "Select country",
          "settings.locale.label": "Locale",
          "settings.locale.placeholder": "Select locale",
          "settings.timezone.label": "Timezone",
          "settings.taxRegime.label": "Tax Regime",
          "settings.taxRegime.placeholder": "Select tax regime",
          "settings.taxRegime.usSalesTax": "US Sales Tax",
          "settings.taxRegime.euVat": "EU VAT",
          "settings.taxRegime.custom": "Custom",
          "settings.pricesIncludeTax": "Prices include tax",
          "settings.primaryTaxId.label": "Primary Seller Tax ID",
          "settings.primaryTaxId.placeholder": "Tax ID",
          "settings.primaryTaxIdScheme.label": "Tax ID Scheme",
          "settings.primaryTaxIdScheme.other": "Other",
          "settings.currency.label": "Currency",
          "settings.currency.placeholder": "Select currency",
        } as const
      )[key] ?? key,
  }
  return { useI18n: () => i18n }
})

vi.mock("../../lib/runtime-distribution", () => ({ useRuntimeDistribution: () => ({ isSelfHost: runtimeState.selfhost }) }))

vi.mock("../../lib/auth-client", () => ({
  authClient: {
    organization: {
      getFullOrganization,
      inviteMember: vi.fn(),
      removeMember: vi.fn(),
      cancelInvitation: vi.fn(),
    },
  },
  useSession: useSessionMock,
}))

vi.mock("../_app/-settings.helpers", () => ({
  shouldAutoLoadAiModels: () => false,
}))

vi.mock("../../trpc/client", () => ({
  trpc: {
    settings: {
      get: {
        query: settingsGetQuery,
      },
      update: {
        mutate: settingsUpdate,
      },
      configureDocumentSendingDomain: {
        mutate: vi.fn(),
      },
      refreshDocumentSendingDomain: {
        mutate: vi.fn(),
      },
      disableDocumentSendingDomain: {
        mutate: vi.fn(),
      },
    },
    ai: {
      listModels: {
        query: vi.fn(),
      },
    },
    runtime: {
      capabilities: {
        query: vi.fn(() =>
          Promise.resolve({
            onboardingV2: { enabled: true, nonVatEnabled: runtimeState.nonVatEnabled },
            aiInvoiceDraft: {
              enabled: true,
              byok: true,
              managed: false,
              managedRequiresSubscription: false,
              customEndpoint: false,
              localAgent: false,
              maxPromptChars: 4000,
            },
          })
        ),
      },
    },
  },
}))

import { Route } from "../_app/settings"

const RouteComponent = (Route as unknown as { component: ComponentType }).component

function buildSettingsData(overrides: Record<string, unknown> = {}) {
  return {
    id: "settings_1",
    countryCode: "US",
    locale: "en-US",
    timezone: "UTC",
    defaultCurrency: "USD",
    taxRegime: "us_sales_tax",
    pricesIncludeTax: false,
    currency: "USD",
    taxRate: null,
    companyName: "Acme LLC",
    companyAddress: "Main St 1",
    companyEmail: "billing@acme.example",
    companyPhone: null,
    companyLogo: null,
    invoicePrefix: "INV",
    invoiceNextNum: 1,
    quotePrefix: "QTE",
    quoteNextNum: 1,
    aiByokConfigured: false,
    aiProvider: "openrouter",
    aiBaseUrl: null,
    aiModel: "openai/gpt-4o-mini",
    stripeByokConfigured: false,
    stripePublishableKey: null,
    onboardingInvoicingIdentity: "registered_business",
    emailDelivery: {
      managed: false,
      configured: false,
      available: false,
      sender: "billing@acme.example",
      missing: [],
      status: "missing_configuration",
    },
    documentSending: {
      status: "disabled",
      requestedDomain: null,
      records: [],
      failureReason: null,
      verifiedAt: null,
      lastSyncedAt: null,
      lastSyncSource: null,
      supportsCustomDomain: false,
      managed: false,
      senderEmail: "billing@acme.example",
    },
    primaryTaxId: null,
    primaryTaxIdScheme: "vat",
    ...overrides,
  }
}

afterEachTest(() => {
  cleanup()
  useSessionMock.mockReset()
  settingsGetQuery.mockReset()
  getFullOrganization.mockReset()
  settingsUpdate.mockReset()
  runtimeState.selfhost = true
  runtimeState.nonVatEnabled = true
})

describe("Settings tax relevance", () => {
  it("hides irrelevant tax id fields and shows danish vat copy when needed", async () => {
    useSessionMock.mockReturnValue({
      data: {
        user: { id: "user_1", email: "test@example.com" },
        session: { activeOrganizationId: "org_1" },
      },
    })
    getFullOrganization.mockResolvedValue({
      data: { members: [], invitations: [] },
    })

    let currentSettingsData = buildSettingsData()
    settingsGetQuery.mockImplementation(() => Promise.resolve(currentSettingsData))

    render(<RouteComponent />)

    await waitFor(() => {
      expect(settingsGetQuery).toHaveBeenCalled()
    })

    expect(screen.queryByLabelText("settings.vatStatus.registered")).toBeNull()
    expect(screen.queryByLabelText("Primary Seller Tax ID")).toBeNull()
    expect(screen.getByText("No tax ID required for this tax setup.")).toBeTruthy()

    cleanup()
    currentSettingsData = buildSettingsData({
      countryCode: "DK",
      locale: "da-DK",
      timezone: "Europe/Copenhagen",
      defaultCurrency: "DKK",
      taxRegime: "eu_vat",
      pricesIncludeTax: true,
    })

    render(<RouteComponent />)

    await waitFor(() => {
      expect(screen.getByLabelText("VAT/CVR number")).toBeTruthy()
    })
    expect(screen.getByText("Required for Danish registered businesses using EU VAT.")).toBeTruthy()
  })
})

async function renderDanishSettings(momsRegistered: boolean | null) {
  useSessionMock.mockReturnValue({ data: { user: { id: "user_1", email: "test@example.com" }, session: { activeOrganizationId: "org_1" } } })
  getFullOrganization.mockResolvedValue({ data: { members: [], invitations: [] } })
  const data = buildSettingsData({ countryCode: "DK", taxRegime: "eu_vat", momsRegistered, taxRate: momsRegistered === false ? 0 : 25 })
  settingsGetQuery.mockResolvedValue(data)
  settingsUpdate.mockResolvedValue(data)
  render(<RouteComponent />)
  await screen.findByLabelText("settings.vatStatus.registered")
}

describe("Settings VAT status", () => {
  it.each([true, false, null])("preserves saved status %s without inventing a choice", async status => {
    await renderDanishSettings(status)
    expect((screen.getByLabelText("settings.vatStatus.registered") as HTMLInputElement).checked).toBe(status === true)
    expect((screen.getByLabelText("settings.vatStatus.notRegistered") as HTMLInputElement).checked).toBe(status === false)
    fireEvent.submit(screen.getByLabelText("settings.companyName.label").closest("form")!)
    await waitFor(() => expect(settingsUpdate).toHaveBeenCalled())
    expect(settingsUpdate.mock.calls[0][0].momsRegistered).toBeUndefined()
  })
  it.each([true, false])("submits changed status %s and related tax defaults", async status => {
    await renderDanishSettings(!status)
    fireEvent.click(screen.getByLabelText(status ? "settings.vatStatus.registered" : "settings.vatStatus.notRegistered"))
    fireEvent.submit(screen.getByLabelText("settings.companyName.label").closest("form")!)
    await waitFor(() => expect(settingsUpdate).toHaveBeenCalled())
    expect(settingsUpdate.mock.calls[0][0]).toMatchObject({ momsRegistered: status, taxRate: status ? 25 : 0, pricesIncludeTax: false })
    if (!status) expect(screen.getByLabelText("settings.vatStatus.cvrLabel")).toBeTruthy()
    fireEvent.submit(screen.getByLabelText("settings.companyName.label").closest("form")!)
    await waitFor(() => expect(settingsUpdate).toHaveBeenCalledTimes(2))
    expect(settingsUpdate.mock.calls[1][0].momsRegistered).toBeUndefined()
  })
  it("disables hosted non-VAT selection without the capability while retaining saved false", async () => {
    runtimeState.selfhost = false
    runtimeState.nonVatEnabled = false
    await renderDanishSettings(false)
    expect((screen.getByLabelText("settings.vatStatus.notRegistered") as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByLabelText("settings.vatStatus.notRegistered") as HTMLInputElement).checked).toBe(true)
  })
})
