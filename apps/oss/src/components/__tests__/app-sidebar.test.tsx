// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

const router = vi.hoisted(() => ({ context: undefined as unknown, pathname: "/" }))

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, ...props }: { children: unknown; to: string; "aria-current"?: "page" }) => (
    <a href={to} aria-current={props["aria-current"]}>
      {children as never}
    </a>
  ),
  useRouterState: (options?: { select: (state: unknown) => unknown }) => {
    const state = { location: { pathname: router.pathname }, matches: [{ context: router.context }] }
    return options ? options.select(state) : state
  },
}))
// What a browser sees: no runtime environment and no build-time variable, so the build-time
// constants say self-host even when the server is cloud. The sidebar must follow the server.
vi.mock("../../lib/distribution", () => ({ isCloudDistribution: false, billingEnabled: false }))
vi.mock("../../lib/i18n/react", () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock("../user-menu", () => ({ UserMenu: () => null }))
vi.mock("../brand/quits-mark", () => ({ QuitsMark: () => null }))
vi.mock("../shell/org-switcher", () => ({ OrgSwitcher: () => null }))
vi.mock("../shell/skip-link", () => ({ SkipLink: () => null }))
vi.mock("../ui/sidebar", () => {
  const Pass = ({ children }: { children?: unknown }) => <div>{children as never}</div>
  return {
    Sidebar: Pass,
    SidebarContent: Pass,
    SidebarFooter: Pass,
    SidebarGroup: ({ children, ...props }: { children?: unknown }) => <div {...props}>{children as never}</div>,
    SidebarGroupLabel: Pass,
    SidebarHeader: Pass,
    SidebarMenu: Pass,
    SidebarMenuItem: Pass,
    SidebarMenuButton: Pass,
    useSidebar: () => ({ setOpenMobile: () => undefined }),
  }
})

import { AppSidebar } from "../app-sidebar"

afterEach(() => {
  cleanup()
  router.context = undefined
  router.pathname = "/"
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

describe("sidebar navigation", () => {
  it("groups the pages under labelled sales, customers and money groups", () => {
    render(<AppSidebar />)

    for (const label of ["nav.group.sales", "nav.group.customersCatalog", "nav.group.money"]) {
      expect(screen.queryByText(label)).not.toBeNull()
    }
    const sales = screen.getByRole("group", { name: "nav.group.sales" })
    expect(sales.textContent).toContain("nav.invoices")
    expect(sales.textContent).toContain("nav.quotes")
    expect(sales.textContent).toContain("nav.agreements")
    expect(sales.textContent).toContain("nav.recurring")
    expect(screen.getByRole("group", { name: "nav.group.money" }).textContent).toContain("nav.creditNotes")
  })

  it("marks only the page you are on as current, including pages below it", () => {
    router.pathname = "/invoices/inv_1"
    render(<AppSidebar />)

    const current = screen.getAllByRole("link").filter((link) => link.getAttribute("aria-current") === "page")
    expect(current.map((link) => link.getAttribute("href"))).toEqual(["/invoices"])
  })

  it("has a landmark for the pages", () => {
    render(<AppSidebar />)
    expect(screen.getByRole("navigation", { name: "shell.nav.label" })).not.toBeNull()
  })
})
