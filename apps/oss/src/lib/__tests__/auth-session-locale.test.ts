import { afterEach, describe, expect, it, vi } from "vitest"

// MOCK: authentication/session and settings calls only, no production users or database.
const state = vi.hoisted(() => ({ getSession: vi.fn(), findUnique: vi.fn() }))
vi.mock("@tanstack/react-start", () => ({ createServerFn: () => ({ handler: (handler: unknown) => handler }) }))
vi.mock("@tanstack/react-start/server", () => ({ getRequestHeaders: () => new Headers() }))
vi.mock("../auth", () => ({ auth: { api: { getSession: state.getSession } } }))
vi.mock("../db", () => ({ prisma: { orgSettings: { findUnique: state.findUnique } } }))
vi.mock("../runtime-distribution", () => ({ readRuntimeDistribution: () => ({ distribution: "selfhost" }) }))
vi.mock("../cloud-onboarding-session", () => ({ loadCloudOnboardingState: vi.fn() }))
import { getAppLayoutSession } from "../auth-session"

afterEach(() => vi.resetAllMocks())
describe("app layout session locale", () => {
  it("leaves locale absent before organization selection so onboarding can detect the browser", async () => {
    state.getSession.mockResolvedValue({ user: { id: "MOCK-user" }, session: { activeOrganizationId: null } })
    const session = await getAppLayoutSession()
    expect(session.activeOrganizationId).toBeNull()
    expect(session.locale).toBeUndefined()
    expect(state.findUnique).not.toHaveBeenCalled()
  })
  it("leaves locale absent for an active organization without settings", async () => {
    state.getSession.mockResolvedValue({ user: { id: "MOCK-user" }, session: { activeOrganizationId: "MOCK-org" } })
    state.findUnique.mockResolvedValue(null)
    const session = await getAppLayoutSession()
    expect(session.activeOrganizationId).toBe("MOCK-org")
    expect(session.locale).toBeUndefined()
    expect(state.findUnique).toHaveBeenCalledWith({ where: { organizationId: "MOCK-org" }, select: { locale: true } })
  })
  it("loads the active organization's locale for initial shell rendering", async () => {
    state.getSession.mockResolvedValue({ user: { id: "MOCK-user" }, session: { activeOrganizationId: "MOCK-org" } })
    state.findUnique.mockResolvedValue({ locale: "da-DK" })
    const session = await getAppLayoutSession()
    expect(session.locale).toBe("da-DK")
    expect(state.findUnique).toHaveBeenCalledWith({ where: { organizationId: "MOCK-org" }, select: { locale: true } })
  })
})
