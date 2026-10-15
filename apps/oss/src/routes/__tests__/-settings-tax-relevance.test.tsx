// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ComponentType, ReactNode } from "react"
import { afterEach as afterEachTest, describe, expect, it, vi } from "vitest"

const {
  capabilitiesQuery,
  hostedFlag,
  distribution,
  prepareConfirmation,
  useSessionMock,
  settingsGetQuery,
  settingsUpdate,
  getFullOrganization,
  organizationUpdate,
  runtimeState,
  displayLanguage,
} = vi.hoisted(() => ({
  displayLanguage: { locale: "da-DK" },
  capabilitiesQuery: vi.fn(),
  hostedFlag: { enabled: false, nonVatEnabled: true },
  distribution: { selfhost: true },
  prepareConfirmation: vi.fn(async () => ({ token: "signed" })),
  useSessionMock: vi.fn(),
  settingsGetQuery: vi.fn(),
  settingsUpdate: vi.fn(),
  getFullOrganization: vi.fn(),
  organizationUpdate: vi.fn(),
  runtimeState: { selfhost: true, nonVatEnabled: true },
}))

vi.mock("../../lib/distribution", () => ({ get isSelfHostDistribution() { return distribution.selfhost } }))

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({ ...options }),
}))

// MOCK: native selects exercise the route's controlled value-change handlers without browser APIs.
vi.mock("../../components/ui/select", () => ({
  Select: ({ value, onValueChange, children }: { value: string; onValueChange: (value: string) => void; children: ReactNode }) => <select value={value} onChange={event => onValueChange(event.target.value)}>{children}</select>,
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: ReactNode }) => <option value={value}>{children}</option>,
}))

vi.mock("../../components/settings/document-email-sending-card", () => ({
  DocumentEmailSendingCard: () => <div>document-sending-card</div>,
}))

vi.mock("../../components/settings/email-delivery-card", () => ({
  EmailDeliveryCard: () => <div>email-delivery-card</div>,
}))

vi.mock("../../lib/i18n/react", async () => {
  const { translate } = await import("../../lib/i18n/translate")
  const i18n = {
    get locale() { return displayLanguage.locale },
    t: (key: string) => key === "auth.onboarding.primary.dkLabel" || key === "auth.onboarding.primary.dkHelp"
      ? translate(key, displayLanguage.locale)
      :
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
      update: organizationUpdate,
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
      prepareSellerVatConfirmation: { mutate: prepareConfirmation },
      capabilities: {
        query: () => capabilitiesQuery() ??
          Promise.resolve({
            sellerVatConfirmation: { enabled: hostedFlag.enabled },
            onboardingV2: { nonVatEnabled: hostedFlag.nonVatEnabled },
            aiInvoiceDraft: {
              enabled: true,
              byok: true,
              managed: false,
              managedRequiresSubscription: false,
              customEndpoint: false,
              localAgent: false,
              maxPromptChars: 4000,
            },
          }),
      },
    },
  },
}))

import { Route } from "../_app/settings"
import { RuntimeUiProvider, type SettingsCompanyDetailsProps } from "../../lib/runtime/ui"
import { initializeRequestOrganizationId, resetRequestOrganizationForTesting } from "../../lib/active-organization"

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
    paymentTermsDays: 14,
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
  displayLanguage.locale = "da-DK"
  capabilitiesQuery.mockReset()
  hostedFlag.enabled = false
  hostedFlag.nonVatEnabled = true
  distribution.selfhost = true
  prepareConfirmation.mockClear()
  resetRequestOrganizationForTesting()
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView")
  useSessionMock.mockReset()
  settingsGetQuery.mockReset()
  settingsUpdate.mockReset()
  getFullOrganization.mockReset()
  settingsUpdate.mockReset()
  organizationUpdate.mockReset()
  runtimeState.selfhost = true
  runtimeState.nonVatEnabled = true
})

describe("Settings tax relevance", () => {
  it.each([
    ["da-DK", "en-US", "CVR-nr.", "VAT/CVR number"],
    ["en-US", "da-DK", "VAT/CVR number", "CVR-nr."],
  ])("renders the Danish tax ID label in display locale %s, independent of saved locale %s", async (displayLocale, savedLocale, label, otherLabel) => {
    displayLanguage.locale = displayLocale
    useSessionMock.mockReturnValue({ data: { user: { id: "user_1" }, session: { activeOrganizationId: "org_1" } } })
    getFullOrganization.mockResolvedValue({ data: { members: [], invitations: [] } })
    settingsGetQuery.mockResolvedValue(buildSettingsData({
      countryCode: "DK",
      locale: savedLocale,
      taxRegime: "eu_vat",
      momsRegistered: true,
      primaryTaxId: "24256790",
    }))
    const { rerender } = render(<RouteComponent />)
    const input = await screen.findByLabelText(label) as HTMLInputElement
    expect(input.placeholder).toBe(label)
    expect(input.value).toBe("24256790")
    expect(screen.queryByLabelText(otherLabel)).toBeNull()
    const help = displayLocale === "da-DK"
      ? "Påkrævet for danske registrerede virksomheder med moms."
      : "Required for Danish registered businesses using EU VAT."
    expect(screen.getByText(help)).toBeTruthy()

    displayLanguage.locale = savedLocale
    rerender(<RouteComponent />)
    expect(screen.getByLabelText(otherLabel)).toBe(input)
    expect(input.placeholder).toBe(otherLabel)
    expect(input.value).toBe("24256790")
    expect(settingsUpdate).not.toHaveBeenCalled()
  })

  it.each(["pending", "failed"])("does not gate self-hosted saves when capabilities are %s", async state => {
    capabilitiesQuery.mockReturnValueOnce(state === "failed" ? Promise.reject(new Error("unavailable")) : new Promise(() => {}))
    useSessionMock.mockReturnValue({ data: { user: { id: "user_1" }, session: { activeOrganizationId: "org_1" } } })
    getFullOrganization.mockResolvedValue({ data: { members: [], invitations: [] } })
    const current = buildSettingsData({ countryCode: "DK", taxRegime: "eu_vat", momsRegistered: false })
    settingsGetQuery.mockResolvedValue(current)
    settingsUpdate.mockImplementation(async input => ({ ...current, ...input }))
    const { container } = render(<RouteComponent />)
    await screen.findByRole("radio", { name: "vatStatus.no" })
    fireEvent.submit(container.querySelector("form")!)
    await waitFor(() => expect(settingsUpdate).toHaveBeenCalledWith(expect.objectContaining({ momsRegistered: undefined, sellerVatConfirmationToken: undefined })))
    expect(screen.queryByRole("button", { name: "settings.capabilities.retry" })).toBeNull()
    expect(prepareConfirmation).not.toHaveBeenCalled()
  })

  it.each([true, false, null])("omits stored VAT %s on unrelated saves while hosted capabilities are pending or failed, then retries without losing edits", async stored => {
    distribution.selfhost = false
    hostedFlag.enabled = true
    let reject!: (error: Error) => void
    capabilitiesQuery.mockReturnValueOnce(new Promise((_resolve, fail) => { reject = fail }))
    useSessionMock.mockReturnValue({ data: { user: { id: "user_1" }, session: { activeOrganizationId: "org_1" } } })
    getFullOrganization.mockResolvedValue({ data: { members: [], invitations: [] } })
    const current = buildSettingsData({ countryCode: "DK", taxRegime: "eu_vat", momsRegistered: stored, primaryTaxId: "24256790" })
    settingsGetQuery.mockResolvedValue(current)
    settingsUpdate.mockImplementation(async input => ({ ...current, ...input, momsRegistered: input.momsRegistered ?? stored }))
    const { container } = render(<RouteComponent />)
    await screen.findByLabelText(stored === false ? "settings.vatStatus.cvrLabel" : "CVR-nr.")
    const email = container.querySelector('[name="companyEmail"]')! as HTMLInputElement
    fireEvent.change(email, { target: { value: "edited@example.test" } })
    fireEvent.submit(container.querySelector("form")!)
    await waitFor(() => expect(settingsUpdate).toHaveBeenCalledWith(expect.objectContaining({ companyEmail: "edited@example.test", momsRegistered: undefined, sellerVatConfirmationToken: undefined })))
    reject(new Error("unavailable"))
    const retry = await screen.findByRole("button", { name: "settings.capabilities.retry" })
    settingsUpdate.mockClear()
    fireEvent.submit(container.querySelector("form")!)
    await waitFor(() => expect(settingsUpdate).toHaveBeenCalledWith(expect.objectContaining({ momsRegistered: undefined, sellerVatConfirmationToken: undefined })))
    fireEvent.click(retry)
    await screen.findByRole("radio", { name: "vatStatus.yes" })
    expect(email.value).toBe("edited@example.test")
    expect(settingsGetQuery).toHaveBeenCalledTimes(1)
    settingsUpdate.mockClear()
    fireEvent.submit(container.querySelector("form")!)
    await waitFor(() => expect(settingsUpdate).toHaveBeenCalledWith(expect.objectContaining({ momsRegistered: undefined, sellerVatConfirmationToken: undefined })))
    fireEvent.click(screen.getByRole("radio", { name: "vatStatus.yes" }))
    fireEvent.submit(container.querySelector("form")!)
    await waitFor(() => expect(settingsUpdate).toHaveBeenCalledWith(expect.objectContaining({ momsRegistered: true, sellerVatConfirmationToken: "signed" })))
  })

  it.each([[false, true, false], [false, true, true], [true, false, false]])("honors non-VAT capability for selfhost %s, confirmation %s, nonVAT %s", async (selfhost, enabled, nonVatEnabled) => {
    distribution.selfhost = selfhost
    hostedFlag.enabled = enabled
    hostedFlag.nonVatEnabled = nonVatEnabled
    useSessionMock.mockReturnValue({ data: { user: { id: "user_1" }, session: { activeOrganizationId: "org_1" } } })
    getFullOrganization.mockResolvedValue({ data: { members: [], invitations: [] } })
    settingsGetQuery.mockResolvedValue(buildSettingsData({ countryCode: "DK", taxRegime: "eu_vat", momsRegistered: null }))
    render(<RouteComponent />)
    await screen.findByRole("radio", { name: "vatStatus.yes" })
    expect(Boolean(screen.queryByRole("radio", { name: "vatStatus.no" }))).toBe(selfhost || nonVatEnabled)
    expect(prepareConfirmation).not.toHaveBeenCalled()
    expect(settingsUpdate).not.toHaveBeenCalled()
  })

  it.each([[true, true], [true, false], [false, true], [false, false]])("shows company choice with hosted confirmation %s and saves registration %s", async (confirmationEnabled, registered) => {
    hostedFlag.enabled = confirmationEnabled
    distribution.selfhost = !confirmationEnabled
    useSessionMock.mockReturnValue({ data: { user: { id: "user_1" }, session: { activeOrganizationId: "org_1" } } })
    getFullOrganization.mockResolvedValue({ data: { members: [], invitations: [] } })
    const current = buildSettingsData({ countryCode: "DK", taxRegime: "eu_vat", momsRegistered: confirmationEnabled ? true : null, primaryTaxId: "24256790" })
    settingsGetQuery.mockResolvedValue(current)
    settingsUpdate.mockImplementation(async input => ({ ...current, ...input }))
    const { container } = render(<RouteComponent />)
    const radios = await screen.findAllByRole("radio") as HTMLInputElement[]
    expect(radios.every(radio => !radio.checked)).toBe(true)
    expect(screen.getByText("sellerCard.body")).toBeTruthy()
    fireEvent.click(radios[registered ? 0 : 1]!)
    fireEvent.submit(container.querySelector("form")!)
    await waitFor(() => expect(settingsUpdate).toHaveBeenCalledWith(expect.objectContaining({ momsRegistered: registered, sellerVatConfirmationToken: confirmationEnabled ? "signed" : undefined, taxRate: registered ? 25 : 0 })))
    if (confirmationEnabled) expect(prepareConfirmation).toHaveBeenCalledWith(expect.objectContaining({ companyName: "Acme LLC", cvr: "24256790", countryCode: "DK" }))
    else expect(prepareConfirmation).not.toHaveBeenCalled()
  })

  it.each(["companyName", "companyAddress", "taxId", "scheme"])("requires a fresh hosted choice after editing %s", async field => {
    hostedFlag.enabled = true
    distribution.selfhost = false
    useSessionMock.mockReturnValue({ data: { user: { id: "user_1" }, session: { activeOrganizationId: "org_1" } } })
    getFullOrganization.mockResolvedValue({ data: { members: [], invitations: [] } })
    const current = buildSettingsData({ countryCode: "DK", taxRegime: "eu_vat", momsRegistered: true, primaryTaxId: "24256790" })
    settingsGetQuery.mockResolvedValue(current)
    settingsUpdate.mockImplementation(async input => ({ ...current, ...input }))
    const { container } = render(<RouteComponent />)
    const radios = await screen.findAllByRole("radio") as HTMLInputElement[]
    let edits = 0
    const edit = () => {
      edits++
      if (field === "scheme") fireEvent.change(Array.from(container.querySelectorAll("select")).find(select => select.value === (edits === 1 ? "vat" : "cvr"))!, { target: { value: edits === 1 ? "cvr" : "vat" } })
      else fireEvent.change(field === "taxId" ? container.querySelector('[name="primaryTaxId"]')! : container.querySelector(`[name="${field}"]`)!, { target: { value: field === "taxId" ? (edits === 1 ? "12345678" : "24256790") : `Changed identity ${edits}` } })
    }
    fireEvent.click(radios[1]!)
    edit()
    expect(radios.every(radio => !radio.checked)).toBe(true)
    fireEvent.click(screen.getByRole("button", { name: "vatStatus.withdraw" }))
    edit()
    fireEvent.submit(container.querySelector("form")!)
    await waitFor(() => expect(settingsUpdate).toHaveBeenCalledWith(expect.objectContaining({ momsRegistered: undefined, sellerVatConfirmationToken: undefined })))
    expect(prepareConfirmation).not.toHaveBeenCalled()
    fireEvent.click(radios[0]!)
    fireEvent.submit(container.querySelector("form")!)
    await waitFor(() => expect(prepareConfirmation).toHaveBeenCalledWith(expect.objectContaining({ primaryTaxIdScheme: "vat" })))
  })

  it("preserves the disabled hosted confirmation flag", async () => {
    distribution.selfhost = false
    useSessionMock.mockReturnValue({ data: { user: { id: "user_1" }, session: { activeOrganizationId: "org_1" } } })
    getFullOrganization.mockResolvedValue({ data: { members: [], invitations: [] } })
    settingsGetQuery.mockResolvedValue(buildSettingsData({ countryCode: "DK", taxRegime: "eu_vat" }))
    render(<RouteComponent />)
    await screen.findByLabelText("settings.taxRate.label")
    expect(screen.queryByRole("radio")).toBeNull()
    expect(prepareConfirmation).not.toHaveBeenCalled()
  })

  it.each([["DE", "eu_vat", "19"], ["US", "custom", "7.5"]])("clears the Danish choice on departure to %s and permits the %s tax default", async (countryCode, taxRegime, taxRate) => {
    useSessionMock.mockReturnValue({ data: { user: { id: "user_1", email: "test@example.com" }, session: { activeOrganizationId: "org_1" } } })
    getFullOrganization.mockResolvedValue({ data: { members: [], invitations: [] } })
    const current = buildSettingsData({ countryCode: "DK", taxRegime, taxRate: 0, momsRegistered: false })
    settingsGetQuery.mockResolvedValue(current)
    settingsUpdate.mockImplementation(async input => ({ ...current, ...input }))
    const { container } = render(<RouteComponent />)
    const taxInput = await screen.findByLabelText("settings.taxRate.label") as HTMLInputElement
    await waitFor(() => expect(taxInput.value).toBe("0"))
    expect(Boolean(screen.queryByRole("radio", { name: "vatStatus.no" }))).toBe(taxRegime === "eu_vat")
    const countrySelect = Array.from(container.querySelectorAll("select")).find(select => select.value === "DK")!
    fireEvent.change(countrySelect, { target: { value: countryCode } })
    expect(screen.queryByRole("radio", { name: "vatStatus.no" })).toBeNull()
    fireEvent.change(taxInput, { target: { value: taxRate } })
    fireEvent.submit(container.querySelector("form")!)
    await waitFor(() => expect(settingsUpdate).toHaveBeenCalledWith(expect.objectContaining({ countryCode, taxRegime, momsRegistered: null, taxRate: Number(taxRate) })))
    await waitFor(() => expect(taxInput.value).toBe(taxRate))
  })
  it.each(["eu_vat", "custom"])("shows the returned %s tax default immediately after saving", async taxRegime => {
    hostedFlag.enabled = taxRegime === "eu_vat"
    useSessionMock.mockReturnValue({ data: { user: { id: "user_1", email: "test@example.com" }, session: { activeOrganizationId: "org_1" } } })
    getFullOrganization.mockResolvedValue({ data: { members: [], invitations: [] } })
    const current = buildSettingsData({ countryCode: "DK", taxRegime, taxRate: 25, momsRegistered: true })
    settingsGetQuery.mockResolvedValue(current)
    settingsUpdate.mockResolvedValue({ ...current, taxRate: taxRegime === "eu_vat" ? 0 : 25, momsRegistered: false })
    const { container } = render(<RouteComponent />)
    const input = await screen.findByLabelText("settings.taxRate.label") as HTMLInputElement
    await waitFor(() => expect(input.value).toBe("25"))
    if (taxRegime === "eu_vat") fireEvent.click(await screen.findByRole("radio", { name: "vatStatus.no" }))
    fireEvent.submit(container.querySelector("form")!)
    await waitFor(() => expect(settingsUpdate).toHaveBeenCalled())
    await waitFor(() => expect(input.value).toBe(taxRegime === "eu_vat" ? "0" : "25"))
    expect(settingsGetQuery).toHaveBeenCalledTimes(1)
  })
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
      expect(screen.getByText("No tax ID required for this tax setup.")).toBeTruthy()
    })

    expect(settingsGetQuery).toHaveBeenCalled()
    expect(screen.queryByLabelText("settings.vatStatus.registered")).toBeNull()
    expect(screen.queryByLabelText("Primary Seller Tax ID")).toBeNull()

    cleanup()
  resetRequestOrganizationForTesting()
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
      expect(screen.getByLabelText("CVR-nr.")).toBeTruthy()
    })
    expect(screen.getByText("Påkrævet for danske registrerede virksomheder med moms.")).toBeTruthy()
    expect(screen.queryByText("Required for Danish registered businesses using EU VAT.")).toBeNull()
  })

  it("clears the saved banner timer before the page unmounts", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true })
    try {
      useSessionMock.mockReturnValue({ data: { user: { id: "user_1" }, session: { activeOrganizationId: "org_1" } } })
      getFullOrganization.mockResolvedValue({ data: { members: [], invitations: [] } })
      const current = buildSettingsData()
      settingsGetQuery.mockResolvedValue(current)
      settingsUpdate.mockImplementation(async input => ({ ...current, ...input }))
      const { container, unmount } = render(<RouteComponent />)
      await screen.findByText("No tax ID required for this tax setup.")
      fireEvent.submit(container.querySelector("form")!)
      await screen.findByRole("status")
      expect(vi.getTimerCount()).toBeGreaterThan(0)
      unmount()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })
})

function submitSettingsForm() {
  const name = screen.getByLabelText("settings.companyName.label") as HTMLInputElement
  fireEvent.submit(name.form!)
}

async function renderDanishSettings(momsRegistered: boolean | null) {
  initializeRequestOrganizationId("org_1")
  useSessionMock.mockReturnValue({ data: { user: { id: "user_1", email: "test@example.com" }, session: { activeOrganizationId: "org_1" } } })
  getFullOrganization.mockResolvedValue({ data: { members: [], invitations: [] } })
  const data = buildSettingsData({ countryCode: "DK", taxRegime: "eu_vat", momsRegistered, taxRate: momsRegistered === false ? 0 : 25 })
  settingsGetQuery.mockResolvedValue(data)
  settingsUpdate.mockImplementation(async input => ({ ...data, ...input, momsRegistered: input.momsRegistered === undefined ? momsRegistered : input.momsRegistered }))
  render(<RouteComponent />)
  await screen.findByRole("radio", { name: "vatStatus.yes" })
}

describe("Settings VAT status after upstream integration", () => {
  it.each([true, false, null])("preserves saved status %s without inventing a choice", async status => {
    await renderDanishSettings(status)
    expect((screen.getByRole("radio", { name: "vatStatus.yes" }) as HTMLInputElement).checked).toBe(status === true)
    expect((screen.getByRole("radio", { name: "vatStatus.no" }) as HTMLInputElement).checked).toBe(status === false)
    submitSettingsForm()
    await waitFor(() => expect(settingsUpdate).toHaveBeenCalled())
    expect(settingsUpdate.mock.calls[0][0].momsRegistered).toBeUndefined()
  })
  it.each([true, false])("submits changed status %s and related tax defaults only once", async status => {
    await renderDanishSettings(!status)
    fireEvent.click(screen.getByRole("checkbox", { name: "Prices include tax" }))
    fireEvent.click(screen.getByRole("radio", { name: status ? "vatStatus.yes" : "vatStatus.no" }))
    submitSettingsForm()
    await waitFor(() => expect(settingsUpdate).toHaveBeenCalled())
    expect(settingsUpdate.mock.calls[0][0]).toMatchObject({ momsRegistered: status, taxRate: status ? 25 : 0, pricesIncludeTax: false })
    if (!status) expect(screen.getByLabelText("settings.vatStatus.cvrLabel")).toBeTruthy()
    await waitFor(() => expect(screen.getByRole("status")).toBeTruthy())
    submitSettingsForm()
    await waitFor(() => expect(settingsUpdate).toHaveBeenCalledTimes(2))
    expect(settingsUpdate.mock.calls[1][0].momsRegistered).toBeUndefined()
  })
  it("hides unsupported hosted non-VAT selection while retaining saved false", async () => {
    distribution.selfhost = false
    hostedFlag.enabled = true
    hostedFlag.nonVatEnabled = false
    await renderDanishSettings(false)
    expect(screen.queryByRole("radio", { name: "vatStatus.no" })).toBeNull()
    expect((screen.getByRole("radio", { name: "vatStatus.yes" }) as HTMLInputElement).checked).toBe(false)
    submitSettingsForm()
    await waitFor(() => expect(settingsUpdate).toHaveBeenCalled())
    expect(settingsUpdate.mock.calls[0][0].momsRegistered).toBeUndefined()
    expect(prepareConfirmation).not.toHaveBeenCalled()
  })
})

describe("Settings UI extension", () => {
  function prepare(organizationId: string | null = "org_1") {
    initializeRequestOrganizationId(organizationId)
    useSessionMock.mockReturnValue({
      data: {
        user: { id: "user_1", email: "test@example.com" },
        session: { activeOrganizationId: organizationId },
      },
    })
    getFullOrganization.mockResolvedValue({ data: { members: [], invitations: [] } })
    settingsGetQuery.mockResolvedValue(buildSettingsData())
    settingsUpdate.mockResolvedValue(buildSettingsData())
  }

  // Test-only adopter fixture: its own form must never submit with OSS settings.
  function CompanyDetails({ organizationId, locale }: SettingsCompanyDetailsProps) {
    return (
      <form data-testid="company-extension" onSubmit={(event) => event.preventDefault()}>
        <input name="adopterField" defaultValue="test-only" />
        {organizationId}:{locale}
      </form>
    )
  }

  it("saves the URL separately and leaves it unchanged when settings fail", async () => {
    prepare()
    getFullOrganization.mockResolvedValue({ data: { slug: "old-slug", members: [], invitations: [] } })
    settingsUpdate.mockRejectedValue(new Error("Rejected settings"))
    organizationUpdate.mockResolvedValue({ data: { slug: "new-slug" } })
    render(<RouteComponent />)
    const slug = await screen.findByDisplayValue("old-slug")
    fireEvent.change(slug, { target: { value: "new-slug" } })
    fireEvent.submit((screen.getByLabelText("settings.companyName.label") as HTMLInputElement).form!)
    expect(await screen.findByText("Rejected settings")).toBeTruthy()
    expect(organizationUpdate).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "settings.organizationSlug.save" }))
    expect(await screen.findByText("settings.organizationSlug.saved")).toBeTruthy()
    expect(organizationUpdate).toHaveBeenCalledWith({ data: { slug: "new-slug" } })
    expect(settingsUpdate).toHaveBeenCalledTimes(1)
  })

  it("keeps the default UI empty and company fields attached to the original save form", async () => {
    prepare()
    const { container } = render(<RouteComponent />)
    await screen.findByText("Company")
    expect(screen.queryByTestId("company-extension")).toBeNull()
    const name = container.querySelector<HTMLInputElement>('input[name="companyName"]')!
    const form = name.form!
    expect(form).toBeTruthy()
    expect(name.closest("form")).toBeNull()
    expect(new FormData(form).get("companyName")).toBe("Acme LLC")
    fireEvent.change(name, { target: { value: "Updated company" } })
    fireEvent.submit(form)
    await waitFor(() => expect(settingsUpdate).toHaveBeenCalledWith(expect.objectContaining({
      companyName: "Updated company",
      companyAddress: "Main St 1",
      companyEmail: "billing@acme.example",
    })))
  })

  it("passes the active organization and display locale immediately after company details, outside the save form", async () => {
    prepare()
    const { container } = render(
      <RuntimeUiProvider value={{ settingsCompanyDetails: CompanyDetails }}><RouteComponent /></RuntimeUiProvider>
    )
    const extension = await screen.findByTestId("company-extension")
    expect(extension.textContent).toBe("org_1:da-DK")
    expect(extension.parentElement?.closest("form")).toBeNull()
    fireEvent.submit(extension)
    expect(settingsUpdate).not.toHaveBeenCalled()
    expect(extension.previousElementSibling?.textContent).toContain("Company description")
    const saveForm = extension.nextElementSibling as HTMLFormElement
    expect(saveForm.tagName).toBe("FORM")
    expect(new FormData(saveForm).has("adopterField")).toBe(false)
    expect(new FormData(saveForm).get("companyAddress")).toBe("Main St 1")
    expect(container.querySelector('input[name="companyEmail"]')?.getAttribute("form")).toBe(saveForm.id)
  })

  it("does not mount the extension without an active organization", async () => {
    prepare(null)
    render(<RuntimeUiProvider value={{ settingsCompanyDetails: CompanyDetails }}><RouteComponent /></RuntimeUiProvider>)
    await screen.findByText("Company")
    expect(screen.queryByTestId("company-extension")).toBeNull()
  })

  it("keeps the layout's organization when another tab changes the live session", async () => {
    prepare()
    useSessionMock.mockReturnValue({
      data: {
        user: { id: "user_1", email: "test@example.com" },
        session: { activeOrganizationId: "org_other_tab" },
      },
    })
    render(<RuntimeUiProvider value={{ settingsCompanyDetails: CompanyDetails }}><RouteComponent /></RuntimeUiProvider>)
    expect((await screen.findByTestId("company-extension")).textContent).toBe("org_1:da-DK")
  })
})
