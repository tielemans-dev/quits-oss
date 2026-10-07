// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { ComponentType } from "react"
import { hydrateRoot } from "react-dom/client"
import { renderToString } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  getSession: vi.fn(),
  loadedOrganizationId: "org_a" as string | null,
  sessionOrganizationId: "org_a" as string | null,
  outletRenders: [] as Array<string | null>,
  reloadPage: vi.fn(),
}))

vi.mock("@tanstack/react-router", async () => {
  const { getRequestOrganizationId } = await import("../../lib/active-organization")
  return {
    createFileRoute: () => (options: Record<string, unknown>) => ({
      ...options,
      useRouteContext: () => ({ session: { session: { activeOrganizationId: state.loadedOrganizationId } } }),
    }),
    redirect: (payload: unknown) => payload,
    // Records the organization the tab acts for whenever a page renders.
    Outlet: () => {
      state.outletRenders.push(getRequestOrganizationId())
      return <p>page</p>
    },
    useNavigate: () => vi.fn(),
    useRouterState: () => ({ location: { pathname: "/" } }),
  }
})

vi.mock("../../lib/auth-session", () => ({ getSession: state.getSession }))
vi.mock("../../lib/auth-client", () => ({
  authClient: { organization: { setActive: vi.fn(async () => ({ data: {}, error: null })) } },
  useSession: () => ({
    data: { session: { activeOrganizationId: state.sessionOrganizationId } },
    isPending: false,
  }),
}))
vi.mock("../../lib/page-navigation", () => ({ loadPage: vi.fn(), reloadPage: state.reloadPage }))
vi.mock("../../lib/cloud-onboarding-session", () => ({ getActiveOrgCloudOnboardingStatus: vi.fn() }))
vi.mock("../../lib/distribution", () => ({ isCloudDistribution: false }))
vi.mock("../../components/ui/sidebar", () => ({
  SidebarProvider: ({ children }: { children: unknown }) => children,
  SidebarTrigger: () => null,
}))
vi.mock("../../components/app-sidebar", () => ({ AppSidebar: () => null }))
vi.mock("../../lib/i18n/react", () => ({ useI18n: () => ({ setLocale: vi.fn(), t: (key: string) => key }) }))
vi.mock("../../trpc/client", () => ({
  trpc: { settings: { get: { query: () => new Promise(() => undefined) } } },
}))

import {
  getRequestOrganizationId,
  isRequestOrganizationInitialized,
  markOrganizationChanged,
  resetRequestOrganizationForTesting,
} from "../../lib/active-organization"
import { Route } from "../_app"

const route = Route as unknown as {
  beforeLoad: (context: unknown) => Promise<unknown>
  component: ComponentType
}

afterEach(() => {
  cleanup()
  resetRequestOrganizationForTesting()
  state.loadedOrganizationId = "org_a"
  state.sessionOrganizationId = "org_a"
  state.outletRenders = []
  state.reloadPage.mockReset()
  vi.restoreAllMocks()
})

function sessionFor(organizationId: string) {
  return { session: { activeOrganizationId: organizationId }, user: { id: "u_1" } }
}

describe("app layout request organization", () => {
  it("sets the organization of the loaded page once the layout has committed", () => {
    render(<route.component />)
    expect(getRequestOrganizationId()).toBe("org_a")
  })

  it("renders pages only once the organization is set", () => {
    render(<route.component />)
    expect(screen.getByText("page")).toBeTruthy()
    expect(state.outletRenders.length).toBeGreaterThan(0)
    expect(state.outletRenders.every((organizationId) => organizationId === "org_a")).toBe(true)
  })

  it("does not write the organization when rendering without committing", () => {
    const html = renderToString(<route.component />)
    expect(isRequestOrganizationInitialized()).toBe(false)
    expect(getRequestOrganizationId()).toBeNull()
    expect(html).not.toContain("page")
    expect(state.outletRenders).toEqual([])
  })

  it("hydrates the server-rendered placeholder without a mismatch, then renders the page", async () => {
    const html = renderToString(<route.component />)
    const container = document.createElement("div")
    container.innerHTML = html
    document.body.appendChild(container)
    const recoverable = vi.fn()
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)

    const root = await act(async () => hydrateRoot(container, <route.component />, { onRecoverableError: recoverable }))

    expect(recoverable).not.toHaveBeenCalled()
    expect(consoleError).not.toHaveBeenCalled()
    expect(getRequestOrganizationId()).toBe("org_a")
    expect(container.textContent).toContain("page")
    expect(state.outletRenders.every((organizationId) => organizationId === "org_a")).toBe(true)
    act(() => root.unmount())
    container.remove()
  })

  it("is not changed by route loaders or preloads after another tab switched organization", async () => {
    render(<route.component />)
    state.getSession.mockResolvedValue(sessionFor("org_b"))

    await route.beforeLoad({ location: { pathname: "/settings" }, preload: true })
    await route.beforeLoad({ location: { pathname: "/settings" }, preload: false })
    expect(getRequestOrganizationId()).toBe("org_a")
  })

  it("keeps the organization when the layout renders again with another one", () => {
    const view = render(<route.component />)
    state.loadedOrganizationId = "org_b"
    state.sessionOrganizationId = "org_b"
    view.rerender(<route.component />)
    expect(getRequestOrganizationId()).toBe("org_a")
  })

  it("keeps the organization of this page load when the layout mounts again", () => {
    const first = render(<route.component />)
    first.unmount()
    state.loadedOrganizationId = "org_b"
    render(<route.component />)
    expect(getRequestOrganizationId()).toBe("org_a")
  })
})

describe("app layout organization changed banner", () => {
  it("asks to reload once the organization changed in another tab", () => {
    render(<route.component />)
    expect(screen.queryByText("ui.organizationChanged.message")).toBeNull()

    act(() => markOrganizationChanged())

    expect(screen.getByRole("alert").textContent).toContain("ui.organizationChanged.message")
    fireEvent.click(screen.getByRole("button", { name: "ui.organizationChanged.action" }))
    expect(state.reloadPage).toHaveBeenCalledTimes(1)
  })
})
