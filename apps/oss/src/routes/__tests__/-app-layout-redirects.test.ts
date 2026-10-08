import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  getAppLayoutSession: vi.fn(),
}))

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => options,
  redirect: (payload: unknown) => payload,
  Outlet: () => null,
  useNavigate: () => vi.fn(),
  useRouterState: () => ({ location: { pathname: "/" } }),
}))
vi.mock("../../lib/auth-session", () => ({ getAppLayoutSession: state.getAppLayoutSession }))
vi.mock("../../lib/distribution", () => ({ isCloudDistribution: true }))
vi.mock("../../lib/auth-client", () => ({ useSession: () => ({ data: null }) }))
vi.mock("../../lib/i18n/react", () => ({ useI18n: () => ({ setLocale: vi.fn() }) }))
vi.mock("../../trpc/client", () => ({ trpc: { settings: { get: { query: () => new Promise(() => undefined) } } } }))
vi.mock("../../components/app-sidebar", () => ({ AppSidebar: () => null }))
vi.mock("../../components/organization-changed-banner", () => ({ OrganizationChangedBanner: () => null }))
vi.mock("../../components/ui/sidebar", () => ({
  SidebarProvider: ({ children }: { children: unknown }) => children,
  SidebarTrigger: () => null,
}))

import { Route } from "../_app"

const route = Route as unknown as {
  beforeLoad: (context: unknown) => Promise<unknown>
}

function layout(organizationId: string | null, cloudOnboardingComplete: boolean | null) {
  return {
    session: {
      session: { activeOrganizationId: organizationId },
      user: { id: "u_1" },
    },
    cloudOnboardingComplete,
  }
}

async function load(pathname: string) {
  try {
    return await route.beforeLoad({ location: { pathname } })
  } catch (redirect) {
    return redirect
  }
}

beforeEach(() => {
  state.getAppLayoutSession.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("app layout redirects on cloud", () => {
  it("sends a signed-out visitor to login", async () => {
    state.getAppLayoutSession.mockResolvedValue({ session: null, cloudOnboardingComplete: null })
    expect(await load("/settings")).toEqual({ to: "/login" })
  })

  it("sends a user without an active organization to onboarding", async () => {
    state.getAppLayoutSession.mockResolvedValue(layout(null, null))
    expect(await load("/invoices")).toEqual({ to: "/onboarding" })
  })

  it("lets a user without an active organization stay on onboarding", async () => {
    state.getAppLayoutSession.mockResolvedValue(layout(null, null))
    expect(await load("/onboarding")).toHaveProperty("session")
  })

  it("sends an incomplete organization to cloud onboarding from an app page", async () => {
    state.getAppLayoutSession.mockResolvedValue(layout("org_a", false))
    expect(await load("/invoices")).toEqual({ to: "/onboarding" })
  })

  it("keeps an incomplete organization on onboarding", async () => {
    state.getAppLayoutSession.mockResolvedValue(layout("org_a", false))
    expect(await load("/onboarding/company")).toHaveProperty("session")
  })

  it("sends a completed organization away from onboarding", async () => {
    state.getAppLayoutSession.mockResolvedValue(layout("org_a", true))
    expect(await load("/onboarding")).toEqual({ to: "/" })
  })

  it("lets a completed organization use app pages", async () => {
    state.getAppLayoutSession.mockResolvedValue(layout("org_a", true))
    expect(await load("/invoices")).toHaveProperty("session")
  })

  it("treats a missing onboarding status as incomplete", async () => {
    state.getAppLayoutSession.mockResolvedValue(layout("org_a", null))
    expect(await load("/invoices")).toEqual({ to: "/onboarding" })
  })

  it("resolves the session with a single server call per navigation", async () => {
    state.getAppLayoutSession.mockResolvedValue(layout("org_a", true))
    await load("/invoices")
    expect(state.getAppLayoutSession).toHaveBeenCalledTimes(1)
  })
})
