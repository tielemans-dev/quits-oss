// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ComponentType } from "react"

const {
  navigate,
  invalidate,
  useSessionMock,
  isCloudDistributionMock,
  onboardingStatusQuery,
  runtimeCapabilitiesQuery,
  uiLocale,
} = vi.hoisted(() => ({
  navigate: vi.fn(),
  invalidate: vi.fn(),
  useSessionMock: vi.fn(),
  isCloudDistributionMock: vi.fn(() => true),
  onboardingStatusQuery: vi.fn(),
  runtimeCapabilitiesQuery: vi.fn(),
  uiLocale: { value: "en-US" },
}))

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({ ...options, useSearch: () => ({}) }),
  useNavigate: () => navigate,
  useRouter: () => ({ invalidate }),
}))

vi.mock("../../lib/i18n/react", async () => {
  const { translate } = await import("../../lib/i18n/translate")
  return { I18nProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>, useI18n: () => ({ locale: uiLocale.value, t: (key: Parameters<typeof translate>[0], vars?: Record<string, string | number>) => translate(key, uiLocale.value, vars) }) }
})

// The distribution comes from the server's route context; these pages only read the resolved value.
vi.mock("../../lib/runtime-distribution", () => ({
  useRuntimeDistribution: () => {
    const isCloud = isCloudDistributionMock()
    return {
      distribution: isCloud ? "cloud" : "selfhost",
      billingEnabled: isCloud,
      isCloud,
      isSelfHost: !isCloud,
    }
  },
}))

vi.mock("../../lib/auth-client", () => ({
  authClient: {
    organization: {
      list: vi.fn(),
      setActive: vi.fn(),
      create: vi.fn(),
    },
  },
  useSession: useSessionMock,
}))

vi.mock("../../trpc/client", () => ({
  trpc: {
    cvr: { available: { query: vi.fn(async () => ({ enabled: false, suggestions: false })) }, setupAvailable: { query: vi.fn(async () => ({ enabled: false })) } },
    onboarding: {
      getStatus: {
        query: onboardingStatusQuery,
      },
      saveDraft: {
        mutate: vi.fn(),
      },
      completeManual: {
        mutate: vi.fn(),
      },
    },
    runtime: {
      capabilities: {
        query: runtimeCapabilitiesQuery,
      },
    },
  },
}))

import { invalidateAppLayoutSession, reuseAppLayoutSession } from "../../lib/app-layout-session"
import { trpc } from "../../trpc/client"
import { Route } from "../_app/onboarding"
import { stageSelectedCompany } from "../../lib/onboarding/selected-company"

const RouteComponent = (Route as unknown as { component: ComponentType }).component

afterEach(() => {
  uiLocale.value = "en-US"
  vi.mocked(trpc.onboarding.saveDraft.mutate).mockReset()
  vi.mocked(trpc.onboarding.completeManual.mutate).mockReset()
  cleanup()
  invalidateAppLayoutSession()
  navigate.mockReset()
  invalidate.mockReset()
  useSessionMock.mockReset()
  isCloudDistributionMock.mockReset()
  isCloudDistributionMock.mockReturnValue(true)
  onboardingStatusQuery.mockReset()
  runtimeCapabilitiesQuery.mockReset()
})

describe("OnboardingPage cloud flow", () => {
  it("disables setup fields until the initial status response has loaded", async () => {
    useSessionMock.mockReturnValue({ data: { user: { id: "user_1" }, session: { activeOrganizationId: "org_1" } } })
    runtimeCapabilitiesQuery.mockResolvedValue({ onboardingAi: { enabled: false } })
    let resolveStatus!: (value: unknown) => void
    onboardingStatusQuery.mockImplementationOnce(() => new Promise((resolve) => { resolveStatus = resolve }))
    render(<RouteComponent />)
    const companyName = await screen.findByLabelText("Company name") as HTMLInputElement
    expect(companyName.matches(":disabled")).toBe(true)
    expect((screen.getByLabelText("Locale") as HTMLSelectElement).matches(":disabled")).toBe(true)
    resolveStatus({ isComplete: false, missing: [], values: { companyName: "Saved company", locale: "en-US" } })
    await waitFor(() => expect(companyName.matches(":disabled")).toBe(false))
    expect(companyName.value).toBe("Saved company")
    fireEvent.change(companyName, { target: { value: "Reviewed company" } })
    expect(companyName.value).toBe("Reviewed company")
  })

  it("shows neither the legacy setup form nor v2 until v2 availability resolves", async () => {
    useSessionMock.mockReturnValue({ data: { user: { id: "user_1", email: "o@example.com" }, session: { activeOrganizationId: "org_1" } } })
    runtimeCapabilitiesQuery.mockResolvedValue({ onboardingAi: { enabled: false }, onboardingV2: { enabled: true }, sellerVatConfirmation: { enabled: true } })
    onboardingStatusQuery.mockResolvedValue({ isComplete: false, values: {}, missing: [] })
    let resolveAvailability!: (value: unknown) => void
    vi.mocked(trpc.cvr.available.query).mockImplementationOnce(() => new Promise((resolve) => { resolveAvailability = resolve }) as never)
    render(<RouteComponent />)
    expect(await screen.findByRole("status")).toBeTruthy()
    expect(screen.queryByText("Finish organization setup")).toBeNull()
    expect(screen.queryByText("Business basics")).toBeNull()
    resolveAvailability({ enabled: false, suggestions: false })
    await waitFor(() => expect(screen.queryByRole("status")?.textContent).not.toBe("Loading onboarding state…"))
  })

  it("offers a retry instead of the legacy form when v2 availability fails", async () => {
    useSessionMock.mockReturnValue({ data: { user: { id: "user_1", email: "o@example.com" }, session: { activeOrganizationId: "org_1" } } })
    runtimeCapabilitiesQuery.mockResolvedValue({ onboardingAi: { enabled: false }, onboardingV2: { enabled: true }, sellerVatConfirmation: { enabled: true } })
    onboardingStatusQuery.mockResolvedValue({ isComplete: false, values: {}, missing: [] })
    vi.mocked(trpc.cvr.available.query)
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce({ enabled: false, suggestions: false } as never)
    render(<RouteComponent />)
    const retry = await screen.findByRole("button", { name: "Try again" })
    const callsBeforeRetry = vi.mocked(trpc.cvr.available.query).mock.calls.length
    expect(screen.queryByText("Finish organization setup")).toBeNull()
    expect(screen.queryByText("Business basics")).toBeNull()
    fireEvent.click(retry)
    await waitFor(() => expect(trpc.cvr.available.query).toHaveBeenCalledTimes(callsBeforeRetry + 1))
    await waitFor(() => expect(screen.queryByRole("button", { name: "Try again" })).toBeNull())
  })

  it("retries runtime capabilities with v2 availability before mounting v2", async () => {
    useSessionMock.mockReturnValue({ data: { user: { id: "user_1", email: "o@example.com" }, session: { activeOrganizationId: "org_1" } } })
    onboardingStatusQuery.mockResolvedValue({ isComplete: false, values: {}, missing: [] })
    runtimeCapabilitiesQuery.mockRejectedValue(new Error("network"))
    vi.mocked(trpc.cvr.available.query)
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce({ enabled: true, suggestions: false } as never)
      .mockResolvedValueOnce({ enabled: true, suggestions: false } as never)
    render(<RouteComponent />)
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }))
    // Availability recovered but capabilities did not: keep offering the retry, not v2.
    expect(await screen.findByRole("button", { name: "Try again" })).toBeTruthy()
    const capabilityCalls = runtimeCapabilitiesQuery.mock.calls.length
    runtimeCapabilitiesQuery.mockResolvedValue({ onboardingAi: { enabled: false }, onboardingV2: { enabled: true }, sellerVatConfirmation: { enabled: true } })
    fireEvent.click(screen.getByRole("button", { name: "Try again" }))
    await waitFor(() => expect(runtimeCapabilitiesQuery.mock.calls.length).toBeGreaterThan(capabilityCalls))
    await waitFor(() => expect(screen.queryByRole("button", { name: "Try again" })).toBeNull())
  })

  it("does not mount v2 from a stale availability result when the retry's availability read fails", async () => {
    useSessionMock.mockReturnValue({ data: { user: { id: "user_1", email: "o@example.com" }, session: { activeOrganizationId: "org_1" } } })
    onboardingStatusQuery.mockResolvedValue({ isComplete: false, values: {}, missing: [] })
    runtimeCapabilitiesQuery.mockRejectedValueOnce(new Error("network"))
    runtimeCapabilitiesQuery.mockResolvedValue({ onboardingAi: { enabled: false }, onboardingV2: { enabled: true }, sellerVatConfirmation: { enabled: true } })
    vi.mocked(trpc.cvr.available.query)
      .mockResolvedValueOnce({ enabled: true, suggestions: false } as never)
      .mockRejectedValueOnce(new Error("network"))
    render(<RouteComponent />)
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }))
    await waitFor(() => expect(vi.mocked(trpc.cvr.available.query).mock.calls.length).toBeGreaterThanOrEqual(2))
    expect(await screen.findByRole("button", { name: "Try again" })).toBeTruthy()
    expect(screen.queryByText("Business basics")).toBeNull()
  })

  it("persists the selected CVR company after loading the newly selected organization", async () => {
    useSessionMock.mockReturnValue({ data: { user: { id: "user_1", email: "test@example.com" }, session: { activeOrganizationId: "org_1" } } })
    runtimeCapabilitiesQuery.mockResolvedValue({ onboardingAi: { enabled: false } })
    onboardingStatusQuery.mockResolvedValue({ isComplete: false, values: { companyName: null, companyAddress: null }, missing: [] })
    stageSelectedCompany("user_1", "org_1", { name: "Selected ApS", address: "Selected street 1", cvr: "24256790" })
    vi.mocked(trpc.onboarding.saveDraft.mutate).mockResolvedValue({ isComplete: false, values: { companyName: "Selected ApS", companyAddress: "Selected street 1", countryCode: "DK", primaryTaxId: "24256790", primaryTaxIdScheme: "cvr" }, missing: [] } as never)
    render(<RouteComponent />)
    await waitFor(() => expect(trpc.onboarding.saveDraft.mutate).toHaveBeenCalledWith({ companyName: "Selected ApS", companyAddress: "Selected street 1", countryCode: "DK", primaryTaxId: "24256790", primaryTaxIdScheme: "cvr", locale: "en-US" }))
    expect(await screen.findByDisplayValue("Selected ApS")).toBeTruthy()
    expect(screen.getByDisplayValue("Selected street 1")).toBeTruthy()
    expect(screen.getByDisplayValue("24256790")).toBeTruthy()
    expect((screen.getByLabelText("Locale") as HTMLSelectElement).value).toBe("en-US")
    expect(screen.getByText("Finish organization setup")).toBeTruthy()
  })

  it("prefills a manually typed name and keeps the English UI locale", async () => {
    useSessionMock.mockReturnValue({ data: { user: { id: "user_1", email: "owner@example.com" }, session: { activeOrganizationId: "org_1" } } })
    runtimeCapabilitiesQuery.mockResolvedValue({ onboardingAi: { enabled: false } })
    onboardingStatusQuery.mockResolvedValue({ isComplete: false, values: { companyName: null, locale: "da-DK", countryCode: "DK" }, missing: ["companyName"] })
    stageSelectedCompany("user_1", "org_1", { name: "Nordic Advisory" })
    vi.mocked(trpc.onboarding.saveDraft.mutate).mockResolvedValue({ isComplete: false, values: { companyName: "Nordic Advisory", locale: "en-US", countryCode: "DK" }, missing: ["companyAddress"] } as never)
    render(<RouteComponent />)
    await waitFor(() => expect(trpc.onboarding.saveDraft.mutate).toHaveBeenCalledWith({ companyName: "Nordic Advisory", primaryTaxId: null, locale: "en-US" }))
    expect(await screen.findByDisplayValue("Nordic Advisory")).toBeTruthy()
    expect((screen.getByLabelText("Locale") as HTMLSelectElement).value).toBe("en-US")
    expect(screen.getByText("Finish organization setup")).toBeTruthy()
  })

  it("stores the current UI locale when a new organization still has the Danish default", async () => {
    useSessionMock.mockReturnValue({ data: { user: { id: "user_1" }, session: { activeOrganizationId: "org_1" } } })
    runtimeCapabilitiesQuery.mockResolvedValue({ onboardingAi: { enabled: false } })
    onboardingStatusQuery.mockResolvedValue({ isComplete: false, values: { companyName: "", locale: "da-DK", countryCode: "DK" }, missing: ["companyName"] })
    vi.mocked(trpc.onboarding.saveDraft.mutate).mockResolvedValue({ isComplete: false, missing: ["companyName"], values: { locale: "en-US" } } as never)
    render(<RouteComponent />)
    await waitFor(() => expect((screen.getByLabelText("Locale") as HTMLSelectElement).value).toBe("en-US"))
    expect(screen.getByText("Finish organization setup")).toBeTruthy()
    await waitFor(() => expect(trpc.onboarding.saveDraft.mutate).toHaveBeenCalledWith({ locale: "en-US", primaryTaxId: null }))
  })

  it("does not store a legacy locale draft when onboarding v2 is active", async () => {
    useSessionMock.mockReturnValue({ data: { user: { id: "user_1" }, session: { activeOrganizationId: "org_1" } } })
    runtimeCapabilitiesQuery.mockResolvedValue({ onboardingAi: { enabled: false }, onboardingV2: { enabled: true }, sellerVatConfirmation: { enabled: true } })
    onboardingStatusQuery.mockResolvedValue({ isComplete: false, values: { companyName: "", locale: "da-DK", countryCode: "DK" }, missing: ["companyName"] })
    render(<RouteComponent />)
    await waitFor(() => expect(runtimeCapabilitiesQuery).toHaveBeenCalledTimes(2))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(trpc.onboarding.saveDraft.mutate).not.toHaveBeenCalled()
  })

  it("does not store a legacy locale draft when capabilities are unavailable", async () => {
    useSessionMock.mockReturnValue({ data: { user: { id: "user_1" }, session: { activeOrganizationId: "org_1" } } })
    runtimeCapabilitiesQuery.mockRejectedValue(new Error("unavailable"))
    onboardingStatusQuery.mockResolvedValue({ isComplete: false, values: { companyName: "", locale: "da-DK", countryCode: "DK" }, missing: ["companyName"] })
    render(<RouteComponent />)
    await waitFor(() => expect(runtimeCapabilitiesQuery).toHaveBeenCalledTimes(2))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(trpc.onboarding.saveDraft.mutate).not.toHaveBeenCalled()
  })

  it("prefills localized defaults and hides irrelevant tax fields", async () => {
    useSessionMock.mockReturnValue({
      data: {
        user: { id: "user_1", email: "test@example.com" },
        session: { activeOrganizationId: "org_1" },
      },
    })
    onboardingStatusQuery.mockResolvedValue({
      status: "in_progress",
      isComplete: false,
      missing: ["companyName"],
      values: {
        companyName: "",
        companyAddress: "",
        companyEmail: "",
        countryCode: "US",
        invoicingIdentity: "registered_business",
        locale: "en-US",
        timezone: "UTC",
        defaultCurrency: "USD",
        taxRegime: "us_sales_tax",
        pricesIncludeTax: false,
        invoicePrefix: "INV",
        quotePrefix: "QTE",
        primaryTaxId: null,
        primaryTaxIdScheme: "vat",
      },
    })
    runtimeCapabilitiesQuery.mockResolvedValue({
      onboardingAi: { enabled: false },
    })

    render(<RouteComponent />)

    await waitFor(() => {
      expect(onboardingStatusQuery).toHaveBeenCalled()
    })

    expect(screen.getByText("Confirm defaults")).toBeTruthy()

    fireEvent.change(screen.getByLabelText("Country"), {
      target: { value: "DK" },
    })

    expect((screen.getByLabelText("Locale") as HTMLSelectElement).value).toBe("da-DK")
    expect((screen.getByLabelText("Timezone") as HTMLInputElement).value).toBe(
      "Europe/Copenhagen"
    )
    expect((screen.getByLabelText("Default currency") as HTMLSelectElement).value).toBe(
      "DKK"
    )

    fireEvent.click(
      screen.getByRole("button", { name: /I invoice as an individual/i })
    )
    expect(screen.queryByLabelText("VAT/CVR number")).toBeNull()

    fireEvent.click(
      screen.getByRole("button", {
        name: /I invoice through a registered business/i,
      })
    )
    expect(screen.getByLabelText("VAT/CVR number")).toBeTruthy()

    expect(screen.getByText("Advanced defaults")).toBeTruthy()
  })

  it("drops the layout's cached session once onboarding is completed, so the next page is not sent back", async () => {
    useSessionMock.mockReturnValue({
      data: { user: { id: "user_1", email: "test@example.com" }, session: { activeOrganizationId: "org_1" } },
    })
    onboardingStatusQuery.mockResolvedValue({
      status: "in_progress",
      isComplete: false,
      missing: [],
      values: {
        companyName: "Acme",
        companyAddress: "1 Main Street",
        companyEmail: "billing@example.com",
        countryCode: "US",
        invoicingIdentity: "registered_business",
        locale: "en-US",
        timezone: "UTC",
        defaultCurrency: "USD",
        taxRegime: "us_sales_tax",
        pricesIncludeTax: false,
        invoicePrefix: "INV",
        quotePrefix: "QTE",
        primaryTaxId: "US123",
        primaryTaxIdScheme: "vat",
      },
    })
    runtimeCapabilitiesQuery.mockResolvedValue({ onboardingAi: { enabled: false } })
    vi.mocked(trpc.onboarding.saveDraft.mutate).mockResolvedValue({ missing: [] } as never)
    vi.mocked(trpc.onboarding.completeManual.mutate).mockResolvedValue({ isComplete: true } as never)
    const load = vi.fn(async () => ({ user: { id: "u_1" }, cloudOnboardingComplete: false }))
    await reuseAppLayoutSession(load)

    render(<RouteComponent />)
    await waitFor(() => expect(onboardingStatusQuery).toHaveBeenCalled())
    fireEvent.click(await screen.findByRole("button", { name: "Finish onboarding" }))

    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/" }))
    await reuseAppLayoutSession(load)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it("drops the layout's cached session when the status shows onboarding is already complete", async () => {
    useSessionMock.mockReturnValue({
      data: { user: { id: "user_1", email: "test@example.com" }, session: { activeOrganizationId: "org_1" } },
    })
    onboardingStatusQuery.mockResolvedValue({ status: "complete", isComplete: true, missing: [], values: null })
    runtimeCapabilitiesQuery.mockResolvedValue({ onboardingAi: { enabled: false } })
    const load = vi.fn(async () => ({ user: { id: "u_1" }, cloudOnboardingComplete: false }))
    await reuseAppLayoutSession(load)

    render(<RouteComponent />)

    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/" }))
    await reuseAppLayoutSession(load)
    expect(load).toHaveBeenCalledTimes(2)
  })
})

describe.each([
  ["da-DK", "Udfyld de markerede felter for at gøre din profil klar til fakturering."],
  ["en-US", "Fill in the marked fields to get your profile ready for invoicing."],
])("onboarding defaults and submit validation in %s", (locale, message) => {
  const label = (english: string) => locale === "da-DK" ? ({ "Locale": "Sprog", "Country": "Land", "Default currency": "Valuta", "Tax setup": "Moms", "Company name": "Virksomhedsnavn", "Company address": "Adresse", "Billing email": "E-mail", "VAT/CVR number": "CVR-nr.", "Finish onboarding": "Afslut opsætning" }[english] ?? english) : english
  it("starts Danish, waits for submit, and completes after correction", async () => {
    uiLocale.value = locale
    useSessionMock.mockReturnValue({ data: { session: { activeOrganizationId: "org_1" } } })
    onboardingStatusQuery.mockResolvedValue({ isComplete: false, values: { locale }, missing: ["companyName", "companyAddress", "companyEmail"] })
    runtimeCapabilitiesQuery.mockResolvedValue({ onboardingAi: { enabled: false } })
    vi.mocked(trpc.onboarding.saveDraft.mutate).mockResolvedValue({ missing: [] } as never)
    vi.mocked(trpc.onboarding.completeManual.mutate).mockResolvedValue({ isComplete: true } as never)
    render(<RouteComponent />)
    expect(screen.queryByRole("alert")).toBeNull()
    await waitFor(() => expect((screen.getByLabelText(label("Locale")) as HTMLSelectElement).value).toBe(locale))
    expect((screen.getByLabelText(label("Country")) as HTMLSelectElement).value).toBe("DK")
    expect((screen.getByLabelText(label("Default currency")) as HTMLSelectElement).value).toBe("DKK")
    expect((screen.getByLabelText(label("Tax setup")) as HTMLSelectElement).value).toBe("eu_vat")
    expect(screen.queryByRole("alert")).toBeNull()
    expect(screen.queryByText(/Missing required fields/)).toBeNull()
    fireEvent.change(screen.getByLabelText(label("Company name")), { target: { value: "Edited before submit" } })
    expect(screen.queryByRole("alert")).toBeNull()
    fireEvent.submit(screen.getByRole("button", { name: label("Finish onboarding") }).closest("form")!)
    expect(screen.getByRole("alert").textContent).toBe(message)
    expect(trpc.onboarding.saveDraft.mutate).not.toHaveBeenCalled()
    expect(trpc.onboarding.completeManual.mutate).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText(label("Company address")), { target: { value: "Example street 1" } })
    fireEvent.change(screen.getByLabelText(label("Billing email")), { target: { value: "billing@example.com" } })
    fireEvent.change(screen.getByLabelText(label("VAT/CVR number")), { target: { value: "12345678" } })
    expect(screen.queryByRole("alert")).toBeNull()
    fireEvent.submit(screen.getByRole("button", { name: label("Finish onboarding") }).closest("form")!)
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/" }))
    expect(trpc.onboarding.saveDraft.mutate).toHaveBeenCalledWith(expect.objectContaining({ countryCode: "DK", defaultCurrency: "DKK", taxRegime: "eu_vat", locale }))
  })

  it("preserves explicit saved and edited jurisdiction/currency/regime choices", async () => {
    uiLocale.value = locale
    useSessionMock.mockReturnValue({ data: { session: { activeOrganizationId: "org_1" } } })
    onboardingStatusQuery.mockResolvedValue({ isComplete: false, missing: [], values: { locale, countryCode: "US", defaultCurrency: "USD", taxRegime: "us_sales_tax" } })
    runtimeCapabilitiesQuery.mockResolvedValue({ onboardingAi: { enabled: false } })
    render(<RouteComponent />)
    await waitFor(() => expect((screen.getByLabelText(label("Country")) as HTMLSelectElement).value).toBe("US"))
    expect((screen.getByLabelText(label("Default currency")) as HTMLSelectElement).value).toBe("USD")
    expect((screen.getByLabelText(label("Tax setup")) as HTMLSelectElement).value).toBe("us_sales_tax")
    fireEvent.change(screen.getByLabelText(label("Default currency")), { target: { value: "GBP" } })
    fireEvent.change(screen.getByLabelText(label("Tax setup")), { target: { value: "custom" } })
    fireEvent.change(screen.getByLabelText(label("Country")), { target: { value: "DK" } })
    fireEvent.change(screen.getByLabelText(label("Locale")), { target: { value: "en-US" } })
    expect((screen.getByLabelText(label("Default currency")) as HTMLSelectElement).value).toBe("GBP")
    expect((screen.getByLabelText(label("Tax setup")) as HTMLSelectElement).value).toBe("custom")
    expect((screen.getByLabelText(label("Country")) as HTMLSelectElement).value).toBe("DK")
  })
})

describe.each([
  ["da-DK", "Udfyld de markerede felter for at gøre din profil klar til fakturering.", "Indtast en gyldig e-mail, fx navn@firma.dk", "Indtast en e-mail", "Udfyld feltet", { name: "Virksomhedsnavn", address: "Adresse", email: "E-mail", finish: "Afslut opsætning" }],
  ["en-US", "Fill in the marked fields to get your profile ready for invoicing.", "Enter a valid email, like name@company.com", "Enter an email", "Fill in this field", { name: "Company name", address: "Company address", email: "Billing email", finish: "Finish onboarding" }],
])("onboarding inline validation messages in %s", (locale, banner, invalidEmail, requiredEmail, required, label) => {
  async function renderIncomplete() {
    uiLocale.value = locale
    useSessionMock.mockReturnValue({ data: { session: { activeOrganizationId: "org_1" } } })
    onboardingStatusQuery.mockResolvedValue({ isComplete: false, values: { locale }, missing: [] })
    runtimeCapabilitiesQuery.mockResolvedValue({ onboardingAi: { enabled: false } })
    vi.mocked(trpc.onboarding.saveDraft.mutate).mockResolvedValue({ missing: [] } as never)
    render(<RouteComponent />)
    await waitFor(() => expect((screen.getByLabelText(label.name) as HTMLInputElement)).toBeTruthy())
  }
  const submit = () => fireEvent.submit(screen.getByRole("button", { name: label.finish }).closest("form")!)

  it("explains an invalid email inline and clears the message and banner once it is fixed", async () => {
    await renderIncomplete()
    fireEvent.change(screen.getByLabelText(label.name), { target: { value: "Synthetic ApS" } })
    fireEvent.change(screen.getByLabelText(label.address), { target: { value: "Example street 1" } })
    fireEvent.change(screen.getByLabelText(label.email), { target: { value: "not-an-email" } })
    submit()
    expect(screen.getByRole("alert").textContent).toBe(banner)
    expect(screen.getByText(invalidEmail)).toBeTruthy()
    expect(screen.getByLabelText(label.email).getAttribute("aria-describedby")).toBe("companyEmail-error")
    fireEvent.change(screen.getByLabelText(label.email), { target: { value: "billing@example.com" } })
    expect(screen.queryByText(invalidEmail)).toBeNull()
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("asks for a missing email and required fields inline, and clears each as it is filled", async () => {
    await renderIncomplete()
    submit()
    expect(screen.getByText(requiredEmail)).toBeTruthy()
    for (const [input, id] of [[label.name, "companyName-error"], [label.address, "companyAddress-error"]]) {
      expect(screen.getByLabelText(input).getAttribute("aria-invalid")).toBe("true")
      expect(screen.getByLabelText(input).getAttribute("aria-describedby")).toBe(id)
      expect(document.getElementById(id)?.textContent).toBe(required)
    }
    expect(screen.getAllByText(required)).toHaveLength(2)
    fireEvent.change(screen.getByLabelText(label.name), { target: { value: "Synthetic ApS" } })
    expect(screen.getAllByText(required)).toHaveLength(1)
    fireEvent.change(screen.getByLabelText(label.address), { target: { value: "Example street 1" } })
    fireEvent.change(screen.getByLabelText(label.email), { target: { value: "billing@example.com" } })
    expect(screen.queryByText(required)).toBeNull()
    expect(screen.queryByText(requiredEmail)).toBeNull()
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("clears the banner for a server-reported missing field once it is filled", async () => {
    await renderIncomplete()
    vi.mocked(trpc.onboarding.saveDraft.mutate).mockResolvedValue({ missing: ["primaryTaxId"] } as never)
    fireEvent.change(screen.getByLabelText(label.name), { target: { value: "Synthetic ApS" } })
    fireEvent.change(screen.getByLabelText(label.address), { target: { value: "Example street 1" } })
    fireEvent.change(screen.getByLabelText(label.email), { target: { value: "billing@example.com" } })
    submit()
    expect((await screen.findByRole("alert")).textContent).toBe(banner)
    fireEvent.change(document.getElementById("primaryTaxId")!, { target: { value: "12345678" } })
    expect(screen.queryByRole("alert")).toBeNull()
  })
})
