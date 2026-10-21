// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ComponentType } from "react"

const { useSessionMock, isCloudDistributionMock, onboardingStatusQuery, runtimeCapabilitiesQuery, availableQuery, setupAvailableQuery, listOrganizations, paymentsFlow } = vi.hoisted(() => ({
  useSessionMock: vi.fn(),
  isCloudDistributionMock: vi.fn(() => true),
  onboardingStatusQuery: vi.fn(),
  runtimeCapabilitiesQuery: vi.fn(),
  availableQuery: vi.fn(),
  setupAvailableQuery: vi.fn(),
  listOrganizations: vi.fn(),
  paymentsFlow: { render: false, settings: vi.fn(), confirm: vi.fn(), navigate: vi.fn() },
}))

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({ ...options, useSearch: () => ({}) }),
  useNavigate: () => paymentsFlow.navigate,
  useRouter: () => ({ invalidate: vi.fn() }),
}))

vi.mock("../../lib/i18n/react", async () => {
  const { translate } = await import("../../lib/i18n/translate")
  const i18n = { locale: "en-US", t: (key: Parameters<typeof translate>[0]) => translate(key, "en-US") }
  return { I18nProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>, useI18n: () => i18n }
})

vi.mock("../../lib/runtime-distribution", () => ({
  useRuntimeDistribution: () => {
    const isCloud = isCloudDistributionMock()
    return { distribution: isCloud ? "cloud" : "selfhost", billingEnabled: isCloud, isCloud, isSelfHost: !isCloud }
  },
}))

vi.mock("../../lib/auth-client", () => ({
  authClient: { organization: { list: listOrganizations, setActive: vi.fn(), create: vi.fn() } },
  useSession: useSessionMock,
}))

// Discovery tests report which flow mounted; the payments regression uses the real form.
vi.mock("../../components/onboarding-v2/onboarding-v2", async (importOriginal) => {
  const { OnboardingV2 } = await importOriginal<typeof import("../../components/onboarding-v2/onboarding-v2")>()
  return {
    OnboardingV2: (props: React.ComponentProps<typeof OnboardingV2>) => paymentsFlow.render
      ? <OnboardingV2 {...props} />
      : <div data-testid="v2" data-confirmation={String(props.confirmationEnabled)} />,
  }
})
vi.mock("../../components/onboarding/company-setup", () => ({
  CompanySetup: () => <input data-testid="company-setup" aria-label="Setup company" />,
}))

vi.mock("../../trpc/client", () => ({
  trpc: {
    cvr: { available: { query: availableQuery }, setupAvailable: { query: setupAvailableQuery } },
    onboarding: { getStatus: { query: onboardingStatusQuery }, saveDraft: { mutate: vi.fn() }, completeManual: { mutate: vi.fn() }, confirmV2: { mutate: paymentsFlow.confirm } },
    runtime: { capabilities: { query: runtimeCapabilitiesQuery } },
    settings: { get: { query: paymentsFlow.settings } },
  },
}))

import { Route } from "../_app/onboarding"
import { requiredLabel } from "../../test-utils/required-label"

const RouteComponent = (Route as unknown as { component: ComponentType }).component

const v2Capabilities = { onboardingAi: { enabled: false }, onboardingV2: { enabled: true }, sellerVatConfirmation: { enabled: true } }
const legacyCapabilities = { onboardingAi: { enabled: false } }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function hostedWithOrganization() {
  isCloudDistributionMock.mockReturnValue(true)
  useSessionMock.mockReturnValue({ data: { user: { id: "user_1", email: "o@example.com" }, session: { activeOrganizationId: "org_1" } } })
  onboardingStatusQuery.mockResolvedValue({ isComplete: false, values: {}, missing: [] })
}

const noFlow = () => {
  expect(screen.queryByTestId("v2")).toBeNull()
  expect(screen.queryByTestId("company-setup")).toBeNull()
  expect(screen.queryByText("Finish organization setup")).toBeNull()
}

afterEach(() => {
  cleanup()
  sessionStorage.clear()
  paymentsFlow.render = false
  paymentsFlow.settings.mockReset()
  paymentsFlow.confirm.mockReset()
  paymentsFlow.navigate.mockReset()
  for (const mock of [useSessionMock, isCloudDistributionMock, onboardingStatusQuery, runtimeCapabilitiesQuery, availableQuery, setupAvailableQuery, listOrganizations]) mock.mockReset()
  isCloudDistributionMock.mockReturnValue(true)
})

describe("onboarding capability discovery", () => {
  it.each([false, true])("offers payments only when enabled=%s, with a Connect handler registered", async (enabled) => {
    hostedWithOrganization()
    paymentsFlow.render = true
    availableQuery.mockResolvedValue({ enabled: true, suggestions: false })
    runtimeCapabilitiesQuery.mockResolvedValue({
      ...v2Capabilities,
      sellerVatConfirmation: { enabled: false },
      payments: { enabled, managed: true, provider: "stripe" },
    })
    paymentsFlow.settings.mockResolvedValue({ stripeAccount: { mode: "connect", status: "none" }, stripeConnectActions: true })
    paymentsFlow.confirm.mockResolvedValue({ status: "complete" })
    render(<RouteComponent />)
    fireEvent.click(await screen.findByRole("button", { name: "Set up manually instead" }))
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Synthetic Seller" } })
    fireEvent.change(screen.getByLabelText("Address"), { target: { value: "Testvej 1" } })
    fireEvent.change(screen.getByLabelText("Company type"), { target: { value: "ApS" } })
    fireEvent.click(screen.getByRole("button", { name: "Create company" }))
    await waitFor(() => expect(paymentsFlow.confirm).toHaveBeenCalledOnce())
    if (enabled) {
      expect(await screen.findByRole("heading", { name: "Get paid by card and MobilePay" })).toBeTruthy()
      expect(paymentsFlow.settings).toHaveBeenCalledOnce()
      expect(paymentsFlow.navigate).not.toHaveBeenCalled()
    } else {
      await waitFor(() => expect(paymentsFlow.navigate).toHaveBeenCalledWith({ to: "/" }))
      expect(screen.queryByRole("heading", { name: "Get paid by card and MobilePay" })).toBeNull()
      expect(paymentsFlow.settings).not.toHaveBeenCalled()
    }
  })

  it.each([
    ["availability first", true],
    ["capabilities first", false],
  ])("shows only a loading state until both reads are known (%s)", async (_name, availabilityFirst) => {
    hostedWithOrganization()
    const availability = deferred<unknown>()
    const capabilities = deferred<unknown>()
    availableQuery.mockReturnValue(availability.promise)
    runtimeCapabilitiesQuery.mockReturnValue(capabilities.promise)
    render(<RouteComponent />)
    expect((await screen.findByRole("status")).textContent).toBe("Loading onboarding state…")

    const [first, second] = availabilityFirst
      ? [() => availability.resolve({ enabled: false, suggestions: false }), () => capabilities.resolve(v2Capabilities)]
      : [() => capabilities.resolve(v2Capabilities), () => availability.resolve({ enabled: false, suggestions: false })]
    first()
    await new Promise(resolve => setTimeout(resolve, 0))
    // One read alone must not pick a flow, even though availability "off" alone would mean legacy.
    expect(screen.getByRole("status")).toBeTruthy()
    noFlow()
    second()
    expect(await screen.findByTestId("company-setup")).toBeTruthy()
    expect(screen.queryByText("Finish organization setup")).toBeNull()
  })

  it("mounts v2 with seller VAT confirmation once both reads succeed", async () => {
    hostedWithOrganization()
    availableQuery.mockResolvedValue({ enabled: true, suggestions: false })
    runtimeCapabilitiesQuery.mockResolvedValue(v2Capabilities)
    render(<RouteComponent />)
    expect((await screen.findByTestId("v2")).getAttribute("data-confirmation")).toBe("true")
  })

  it("fails closed when capabilities fail while availability says v2, and recovers on retry", async () => {
    hostedWithOrganization()
    availableQuery.mockResolvedValue({ enabled: true, suggestions: false })
    runtimeCapabilitiesQuery.mockRejectedValueOnce(new Error("network")).mockResolvedValue(v2Capabilities)
    render(<RouteComponent />)
    expect((await screen.findByRole("alert")).textContent).toBe("Unable to load onboarding status")
    noFlow()
    fireEvent.click(screen.getByRole("button", { name: "Try again" }))
    const v2 = await screen.findByTestId("v2")
    expect(v2.getAttribute("data-confirmation")).toBe("true")
  })

  it("does not fall back to the legacy form when capabilities fail and v2 is off", async () => {
    hostedWithOrganization()
    availableQuery.mockResolvedValue({ enabled: false, suggestions: false })
    runtimeCapabilitiesQuery.mockRejectedValueOnce(new Error("network")).mockResolvedValue(v2Capabilities)
    render(<RouteComponent />)
    expect(await screen.findByRole("button", { name: "Try again" })).toBeTruthy()
    noFlow()
    fireEvent.click(screen.getByRole("button", { name: "Try again" }))
    expect(await screen.findByTestId("company-setup")).toBeTruthy()
  })

  it("shows the error as soon as availability fails, even while capabilities are pending, then retries both", async () => {
    hostedWithOrganization()
    const capabilities = deferred<unknown>()
    availableQuery.mockRejectedValueOnce(new Error("network")).mockResolvedValue({ enabled: true, suggestions: false })
    runtimeCapabilitiesQuery.mockReturnValueOnce(capabilities.promise).mockResolvedValue(v2Capabilities)
    render(<RouteComponent />)
    expect(await screen.findByRole("alert")).toBeTruthy()
    capabilities.resolve(v2Capabilities)
    await new Promise(resolve => setTimeout(resolve, 0))
    // Capabilities arriving does not clear the failed availability read.
    expect(screen.getByRole("alert")).toBeTruthy()
    noFlow()
    fireEvent.click(screen.getByRole("button", { name: "Try again" }))
    expect(await screen.findByTestId("v2")).toBeTruthy()
    expect(availableQuery).toHaveBeenCalledTimes(2)
  })

  it.each([
    ["v2 company setup", { enabled: false, suggestions: false }, "company-setup"],
    ["v2", { enabled: true, suggestions: false }, "v2"],
  ])("mounts no flow from a mix of old and new results while a retry is in flight (%s)", async (_name, availability, flowId) => {
    hostedWithOrganization()
    const retryAvailability = deferred<unknown>()
    availableQuery.mockResolvedValueOnce(availability).mockReturnValueOnce(retryAvailability.promise).mockResolvedValue(availability)
    runtimeCapabilitiesQuery.mockRejectedValueOnce(new Error("network")).mockResolvedValue(v2Capabilities)
    render(<RouteComponent />)
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }))
    // The retried capabilities land while the retried availability read is still pending.
    await waitFor(() => expect(runtimeCapabilitiesQuery.mock.calls.length).toBeGreaterThanOrEqual(2))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(screen.getByRole("status")).toBeTruthy()
    noFlow()
    retryAvailability.reject(new Error("timeout"))
    expect(await screen.findByRole("alert")).toBeTruthy()
    noFlow()
    fireEvent.click(screen.getByRole("button", { name: "Try again" }))
    expect(await screen.findByTestId(flowId)).toBeTruthy()
  })

  it("recovers when both reads fail and the retry succeeds", async () => {
    hostedWithOrganization()
    availableQuery.mockRejectedValueOnce(new Error("network")).mockResolvedValue({ enabled: false, suggestions: false })
    runtimeCapabilitiesQuery.mockRejectedValueOnce(new Error("network")).mockResolvedValue(legacyCapabilities)
    render(<RouteComponent />)
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }))
    expect(await screen.findByText("Finish organization setup")).toBeTruthy()
  })

  it("keeps the saved draft across a failed read and its retry", async () => {
    hostedWithOrganization()
    onboardingStatusQuery.mockResolvedValue({ isComplete: false, values: { companyName: "Saved company", locale: "en-US" }, missing: [] })
    availableQuery.mockResolvedValue({ enabled: false, suggestions: false })
    runtimeCapabilitiesQuery.mockRejectedValueOnce(new Error("network")).mockResolvedValue(legacyCapabilities)
    render(<RouteComponent />)
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }))
    expect(((await screen.findByLabelText(requiredLabel("Company name"))) as HTMLInputElement).value).toBe("Saved company")
  })

  it("keeps the hosted manual form when CVR lookup is unavailable", async () => {
    hostedWithOrganization()
    availableQuery.mockResolvedValue({ enabled: false, suggestions: false })
    runtimeCapabilitiesQuery.mockResolvedValue({ onboardingAi: { enabled: false }, onboardingV2: { enabled: false }, sellerVatConfirmation: { enabled: false } })
    render(<RouteComponent />)
    expect(await screen.findByText("Finish organization setup")).toBeTruthy()
    expect(screen.queryByTestId("v2")).toBeNull()
    expect(screen.queryByTestId("company-setup")).toBeNull()
  })

  it("keeps self-hosted onboarding free of capability gates", async () => {
    isCloudDistributionMock.mockReturnValue(false)
    useSessionMock.mockReturnValue({ data: { user: { id: "user_1" }, session: { activeOrganizationId: null } } })
    listOrganizations.mockResolvedValue({ data: [] })
    render(<RouteComponent />)
    expect(await screen.findByLabelText(requiredLabel("Company name"))).toBeTruthy()
    expect(availableQuery).not.toHaveBeenCalled()
    expect(setupAvailableQuery).not.toHaveBeenCalled()
    expect(runtimeCapabilitiesQuery).not.toHaveBeenCalled()
  })

  it("does not query capabilities for a self-hosted organization", async () => {
    isCloudDistributionMock.mockReturnValue(false)
    useSessionMock.mockReturnValue({ data: { user: { id: "user_1" }, session: { activeOrganizationId: "org_1" } } })
    render(<RouteComponent />)
    expect(await screen.findByRole("button", { name: "Continue to app" })).toBeTruthy()
    expect(availableQuery).not.toHaveBeenCalled()
    expect(runtimeCapabilitiesQuery).not.toHaveBeenCalled()
  })
})
