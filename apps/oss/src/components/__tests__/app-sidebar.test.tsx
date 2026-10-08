// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

const router = vi.hoisted(() => ({ context: undefined as unknown }))

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: unknown; to: string }) => <a href={to}>{children as never}</a>,
  useRouterState: (options?: { select: (state: unknown) => unknown }) => {
    const state = { location: { pathname: "/" }, matches: [{ context: router.context }] }
    return options ? options.select(state) : state
  },
}))
// What a browser sees: no runtime environment and no build-time variable, so the build-time
// constants say self-host even when the server is cloud. The sidebar must follow the server.
vi.mock("../../lib/distribution", () => ({ isCloudDistribution: false, billingEnabled: false }))
vi.mock("../../lib/i18n/react", () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock("../user-menu", () => ({ UserMenu: () => null }))
vi.mock("../brand/quits-mark", () => ({ QuitsMark: () => null }))
vi.mock("../ui/sidebar", () => {
  const Pass = ({ children }: { children?: unknown }) => <div>{children as never}</div>
  return {
    Sidebar: Pass,
    SidebarContent: Pass,
    SidebarFooter: Pass,
    SidebarGroup: Pass,
    SidebarGroupLabel: Pass,
    SidebarHeader: Pass,
    SidebarMenu: Pass,
    SidebarMenuItem: Pass,
    SidebarMenuButton: Pass,
  }
})

import { AppSidebar } from "../app-sidebar"

afterEach(() => {
  cleanup()
  router.context = undefined
})

describe("sidebar billing entry", () => {
  it("shows Billing on cloud, as the server-delivered runtime says", () => {
    router.context = { runtime: { distribution: "cloud", billingEnabled: true } }
    render(<AppSidebar />)
    expect(screen.queryByText("nav.billing")).not.toBeNull()
  })

  it("hides Billing on self-host", () => {
    router.context = { runtime: { distribution: "selfhost", billingEnabled: false } }
    render(<AppSidebar />)
    expect(screen.queryByText("nav.billing")).toBeNull()
    expect(screen.queryByText("nav.invoices")).not.toBeNull()
  })

  it("hides Billing on cloud when billing is switched off", () => {
    router.context = { runtime: { distribution: "cloud", billingEnabled: false } }
    render(<AppSidebar />)
    expect(screen.queryByText("nav.billing")).toBeNull()
  })
})
