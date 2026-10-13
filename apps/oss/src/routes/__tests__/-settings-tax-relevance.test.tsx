// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, fireEvent } from "@testing-library/react"
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
} = vi.hoisted(() => ({
  capabilitiesQuery: vi.fn(),
  hostedFlag: { enabled: false, nonVatEnabled: true },
  distribution: { selfhost: true },
  prepareConfirmation: vi.fn(async () => ({ token: "signed" })),
  useSessionMock: vi.fn(),
  settingsGetQuery: vi.fn(),
  settingsUpdate: vi.fn(),
  getFullOrganization: vi.fn(),
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

vi.mock("../../lib/i18n/react", () => {
  const t = (key: string) =>
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
      )[key] ?? key
  return { useI18n: () => ({ t, locale: "en-US" }) }
})

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
  capabilitiesQuery.mockReset()
  hostedFlag.enabled = false
  hostedFlag.nonVatEnabled = true
  distribution.selfhost = true
  prepareConfirmation.mockClear()
  useSessionMock.mockReset()
  settingsGetQuery.mockReset()
  settingsUpdate.mockReset()
  getFullOrganization.mockReset()
})

describe("Settings tax relevance", () => {
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
    await screen.findByLabelText(stored === false ? "settings.vatStatus.cvrLabel" : "VAT/CVR number")
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
      expect(settingsGetQuery).toHaveBeenCalled()
    })

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
  settingsUpdate.mockImplementation(async input => ({ ...data, ...input, momsRegistered: input.momsRegistered === undefined ? momsRegistered : input.momsRegistered }))
  render(<RouteComponent />)
  await screen.findByRole("radio", { name: "vatStatus.yes" })
}

describe("Settings VAT status after upstream integration", () => {
  it.each([true, false, null])("preserves saved status %s without inventing a choice", async status => {
    await renderDanishSettings(status)
    expect((screen.getByRole("radio", { name: "vatStatus.yes" }) as HTMLInputElement).checked).toBe(status === true)
    expect((screen.getByRole("radio", { name: "vatStatus.no" }) as HTMLInputElement).checked).toBe(status === false)
    fireEvent.submit(screen.getByLabelText("settings.companyName.label").closest("form")!)
    await waitFor(() => expect(settingsUpdate).toHaveBeenCalled())
    expect(settingsUpdate.mock.calls[0][0].momsRegistered).toBeUndefined()
  })
  it.each([true, false])("submits changed status %s and related tax defaults only once", async status => {
    await renderDanishSettings(!status)
    fireEvent.click(screen.getByRole("checkbox", { name: "Prices include tax" }))
    fireEvent.click(screen.getByRole("radio", { name: status ? "vatStatus.yes" : "vatStatus.no" }))
    fireEvent.submit(screen.getByLabelText("settings.companyName.label").closest("form")!)
    await waitFor(() => expect(settingsUpdate).toHaveBeenCalled())
    expect(settingsUpdate.mock.calls[0][0]).toMatchObject({ momsRegistered: status, taxRate: status ? 25 : 0, pricesIncludeTax: false })
    if (!status) expect(screen.getByLabelText("settings.vatStatus.cvrLabel")).toBeTruthy()
    await waitFor(() => expect(screen.getByRole("status")).toBeTruthy())
    fireEvent.submit(screen.getByLabelText("settings.companyName.label").closest("form")!)
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
    fireEvent.submit(screen.getByLabelText("settings.companyName.label").closest("form")!)
    await waitFor(() => expect(settingsUpdate).toHaveBeenCalled())
    expect(settingsUpdate.mock.calls[0][0].momsRegistered).toBeUndefined()
    expect(prepareConfirmation).not.toHaveBeenCalled()
  })
})
