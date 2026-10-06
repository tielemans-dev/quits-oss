// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react"
import type { ComponentType } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  getSession: vi.fn(),
  loadedOrganizationId: "org_a" as string | null,
}))

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({
    ...options,
    useRouteContext: () => ({ session: { session: { activeOrganizationId: state.loadedOrganizationId } } }),
  }),
  redirect: (payload: unknown) => payload,
  Outlet: () => null,
  useNavigate: () => vi.fn(),
  useRouterState: () => ({ location: { pathname: "/" } }),
}))

vi.mock("../../lib/auth-session", () => ({ getSession: state.getSession }))
vi.mock("../../lib/auth-client", () => ({
  authClient: { organization: { setActive: vi.fn(async () => ({ data: {}, error: null })) } },
  useSession: () => ({ data: { session: { activeOrganizationId: state.loadedOrganizationId } }, isPending: false }),
}))
vi.mock("../../lib/cloud-onboarding-session", () => ({ getActiveOrgCloudOnboardingStatus: vi.fn() }))
vi.mock("../../lib/distribution", () => ({ isCloudDistribution: false }))
vi.mock("../../components/ui/sidebar", () => ({
  SidebarProvider: ({ children }: { children: unknown }) => children,
  SidebarTrigger: () => null,
}))
vi.mock("../../components/app-sidebar", () => ({ AppSidebar: () => null }))
vi.mock("../../lib/i18n/react", () => ({ useI18n: () => ({ setLocale: vi.fn() }) }))
vi.mock("../../trpc/client", () => ({
  trpc: { settings: { get: { query: () => new Promise(() => undefined) } } },
}))

import {
  getRequestOrganizationId,
  setRequestOrganizationId,
  switchActiveOrganization,
} from "../../lib/active-organization"
import { Route } from "../_app"

const route = Route as unknown as {
  beforeLoad: (context: unknown) => Promise<unknown>
  component: ComponentType
}

afterEach(() => {
  cleanup()
  setRequestOrganizationId(null)
  state.loadedOrganizationId = "org_a"
})

function sessionFor(organizationId: string) {
  return { session: { activeOrganizationId: organizationId }, user: { id: "u_1" } }
}

describe("app layout request organization", () => {
  it("adopts the organization of the first loaded page", () => {
    render(<route.component />)
    expect(getRequestOrganizationId()).toBe("org_a")
  })

  it("is not changed by preloading a link after another tab switched organization", async () => {
    setRequestOrganizationId("org_a")
    state.getSession.mockResolvedValue(sessionFor("org_b"))

    await route.beforeLoad({ location: { pathname: "/settings" }, preload: true })
    expect(getRequestOrganizationId()).toBe("org_a")

    await route.beforeLoad({ location: { pathname: "/settings" }, preload: false })
    expect(getRequestOrganizationId()).toBe("org_a")
  })

  it("keeps acting for this tab's organization when the layout renders with another one", () => {
    const view = render(<route.component />)
    expect(getRequestOrganizationId()).toBe("org_a")

    state.loadedOrganizationId = "org_b"
    view.rerender(<route.component />)
    expect(getRequestOrganizationId()).toBe("org_a")
  })

  it("follows an explicit switch made in this tab", async () => {
    render(<route.component />)
    await switchActiveOrganization("org_b")
    expect(getRequestOrganizationId()).toBe("org_b")
  })
})
