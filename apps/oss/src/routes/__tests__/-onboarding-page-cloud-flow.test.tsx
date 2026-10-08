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
} = vi.hoisted(() => ({
  navigate: vi.fn(),
  invalidate: vi.fn(),
  useSessionMock: vi.fn(),
  isCloudDistributionMock: vi.fn(() => true),
  onboardingStatusQuery: vi.fn(),
  runtimeCapabilitiesQuery: vi.fn(),
}))

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({ ...options }),
  useNavigate: () => navigate,
  useRouter: () => ({ invalidate }),
}))

vi.mock("../../lib/i18n/react", () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

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
    const load = vi.fn(async () => ({ session: { user: "u_1" }, cloudOnboardingComplete: false }))
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
    const load = vi.fn(async () => ({ session: { user: "u_1" }, cloudOnboardingComplete: false }))
    await reuseAppLayoutSession(load)

    render(<RouteComponent />)

    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/" }))
    await reuseAppLayoutSession(load)
    expect(load).toHaveBeenCalledTimes(2)
  })
})
