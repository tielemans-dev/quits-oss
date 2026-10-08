import { beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  getSession: vi.fn(),
  loadCloudOnboardingState: vi.fn(),
  distribution: { value: "cloud" as "cloud" | "selfhost", billingEnabled: true },
}))

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => ({ handler: (fn: () => unknown) => fn }),
}))
vi.mock("@tanstack/react-start/server", () => ({ getRequestHeaders: () => new Headers() }))
vi.mock("../auth", () => ({ auth: { api: { getSession: state.getSession } } }))
vi.mock("../cloud-onboarding-session", () => ({ loadCloudOnboardingState: state.loadCloudOnboardingState }))
vi.mock("../runtime-distribution", () => ({
  readRuntimeDistribution: () => ({
    distribution: state.distribution.value,
    billingEnabled: state.distribution.billingEnabled,
  }),
}))

import { getAppLayoutSession } from "../auth-session"

const load = getAppLayoutSession as unknown as () => Promise<{
  session: unknown
  activeOrganizationId: string | null
  runtime: { distribution: string; billingEnabled: boolean }
  cloudOnboardingComplete: boolean | null
}>

function signedIn(organizationId: string | null) {
  return { session: { activeOrganizationId: organizationId }, user: { id: "u_1" } }
}

beforeEach(() => {
  state.getSession.mockReset()
  state.loadCloudOnboardingState.mockReset()
  state.distribution = { value: "cloud", billingEnabled: true }
})

describe("getAppLayoutSession", () => {
  it("reads the session once and answers onboarding from the same call on cloud", async () => {
    state.getSession.mockResolvedValue(signedIn("org_a"))
    state.loadCloudOnboardingState.mockResolvedValue({ isComplete: true })

    const result = await load()

    expect(state.getSession).toHaveBeenCalledTimes(1)
    expect(state.loadCloudOnboardingState).toHaveBeenCalledWith("org_a")
    expect(result).toMatchObject({
      activeOrganizationId: "org_a",
      cloudOnboardingComplete: true,
      runtime: { distribution: "cloud", billingEnabled: true },
    })
  })

  it("reports incomplete onboarding", async () => {
    state.getSession.mockResolvedValue(signedIn("org_a"))
    state.loadCloudOnboardingState.mockResolvedValue({ isComplete: false })
    expect((await load()).cloudOnboardingComplete).toBe(false)
  })

  it("skips the onboarding query without an active organization", async () => {
    state.getSession.mockResolvedValue(signedIn(null))
    const result = await load()
    expect(state.loadCloudOnboardingState).not.toHaveBeenCalled()
    expect(result).toMatchObject({ activeOrganizationId: null, cloudOnboardingComplete: null })
  })

  it("skips the onboarding query when signed out", async () => {
    state.getSession.mockResolvedValue(null)
    const result = await load()
    expect(state.loadCloudOnboardingState).not.toHaveBeenCalled()
    expect(result.session).toBeNull()
  })

  it("skips the onboarding query on self-host and says so to the browser", async () => {
    state.distribution = { value: "selfhost", billingEnabled: false }
    state.getSession.mockResolvedValue(signedIn("org_a"))
    const result = await load()
    expect(state.loadCloudOnboardingState).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      cloudOnboardingComplete: null,
      runtime: { distribution: "selfhost", billingEnabled: false },
    })
  })
})
