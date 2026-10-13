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
    cvr: { available: { query: vi.fn(async () => ({ enabled: false, suggestions: false })) } },
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
  ["da-DK", "Udfyld virksomhedsnavn, adresse og e-mail for at fortsætte."],
  ["en-US", "Fill in company name, address and email to continue."],
])("onboarding defaults and submit validation in %s", (locale, message) => {
  it("starts Danish, waits for submit, and completes after correction", async () => {
    uiLocale.value = locale
    useSessionMock.mockReturnValue({ data: { session: { activeOrganizationId: "org_1" } } })
    onboardingStatusQuery.mockResolvedValue({ isComplete: false, values: { locale }, missing: ["companyName", "companyAddress", "companyEmail"] })
    runtimeCapabilitiesQuery.mockResolvedValue({ onboardingAi: { enabled: false } })
    vi.mocked(trpc.onboarding.saveDraft.mutate).mockResolvedValue({ missing: [] } as never)
    vi.mocked(trpc.onboarding.completeManual.mutate).mockResolvedValue({ isComplete: true } as never)
    render(<RouteComponent />)
    expect(screen.queryByRole("alert")).toBeNull()
    await waitFor(() => expect((screen.getByLabelText("Locale") as HTMLSelectElement).value).toBe(locale))
    expect((screen.getByLabelText("Country") as HTMLSelectElement).value).toBe("DK")
    expect((screen.getByLabelText("Default currency") as HTMLSelectElement).value).toBe("DKK")
    expect((screen.getByLabelText("Tax setup") as HTMLSelectElement).value).toBe("eu_vat")
    expect(screen.queryByRole("alert")).toBeNull()
    expect(screen.queryByText(/Missing required fields/)).toBeNull()
    fireEvent.change(screen.getByLabelText("Company name"), { target: { value: "Edited before submit" } })
    expect(screen.queryByRole("alert")).toBeNull()
    fireEvent.submit(screen.getByRole("button", { name: "Finish onboarding" }).closest("form")!)
    expect(screen.getByRole("alert").textContent).toBe(message)
    expect(trpc.onboarding.saveDraft.mutate).not.toHaveBeenCalled()
    expect(trpc.onboarding.completeManual.mutate).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText("Company address"), { target: { value: "Example street 1" } })
    fireEvent.change(screen.getByLabelText("Billing email"), { target: { value: "billing@example.com" } })
    fireEvent.change(screen.getByLabelText("VAT/CVR number"), { target: { value: "12345678" } })
    expect(screen.queryByRole("alert")).toBeNull()
    fireEvent.submit(screen.getByRole("button", { name: "Finish onboarding" }).closest("form")!)
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/" }))
    expect(trpc.onboarding.saveDraft.mutate).toHaveBeenCalledWith(expect.objectContaining({ countryCode: "DK", defaultCurrency: "DKK", taxRegime: "eu_vat", locale }))
  })

  it("preserves explicit saved and edited jurisdiction/currency/regime choices", async () => {
    uiLocale.value = locale
    useSessionMock.mockReturnValue({ data: { session: { activeOrganizationId: "org_1" } } })
    onboardingStatusQuery.mockResolvedValue({ isComplete: false, missing: [], values: { locale, countryCode: "US", defaultCurrency: "USD", taxRegime: "us_sales_tax" } })
    runtimeCapabilitiesQuery.mockResolvedValue({ onboardingAi: { enabled: false } })
    render(<RouteComponent />)
    await waitFor(() => expect((screen.getByLabelText("Country") as HTMLSelectElement).value).toBe("US"))
    expect((screen.getByLabelText("Default currency") as HTMLSelectElement).value).toBe("USD")
    expect((screen.getByLabelText("Tax setup") as HTMLSelectElement).value).toBe("us_sales_tax")
    fireEvent.change(screen.getByLabelText("Default currency"), { target: { value: "GBP" } })
    fireEvent.change(screen.getByLabelText("Tax setup"), { target: { value: "custom" } })
    fireEvent.change(screen.getByLabelText("Country"), { target: { value: "DK" } })
    fireEvent.change(screen.getByLabelText("Locale"), { target: { value: "en-US" } })
    expect((screen.getByLabelText("Default currency") as HTMLSelectElement).value).toBe("GBP")
    expect((screen.getByLabelText("Tax setup") as HTMLSelectElement).value).toBe("custom")
    expect((screen.getByLabelText("Country") as HTMLSelectElement).value).toBe("DK")
  })
})
