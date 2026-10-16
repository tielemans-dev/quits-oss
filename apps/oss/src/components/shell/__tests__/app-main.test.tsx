// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

const permissions = vi.hoisted(() => ({ ready: false, allowed: false }))
const sidebar = vi.hoisted(() => ({ setOpenMobile: vi.fn() }))
const route = vi.hoisted(() => ({ pathname: "/invoices" }))

vi.mock("../../../lib/runtime-distribution", () => ({ useRuntimeDistribution: () => ({ billingEnabled: false }) }))
vi.mock("../../ui/sidebar", () => ({
  SidebarTrigger: () => null,
  useSidebar: () => ({ setOpenMobile: sidebar.setOpenMobile }),
}))
vi.mock("../search-field", () => ({ SearchField: () => <div data-testid="search-field" /> }))
vi.mock("../../user-menu", () => ({ UserMenu: () => null }))
vi.mock("../../../lib/i18n/react", () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock("@tanstack/react-router", () => ({
  Link: () => null,
  useRouterState: ({ select }: { select: (state: { location: { pathname: string } }) => unknown }) => select({ location: route }),
}))
vi.mock("../palette", async () => ({
  onPaletteOpen: (await import("../palette/palette-events")).onPaletteOpen,
  returnFromPalette: (await import("../palette/palette-events")).returnFromPalette,
  CommandPalette: ({ open, initialQuery, onNavigate }: { open: boolean; initialQuery?: string; onNavigate?: () => void }) => (
    <button type="button" data-testid="palette" data-open={open} data-query={initialQuery} onClick={onNavigate}>
      navigate
    </button>
  ),
}))
vi.mock("../use-shell-permissions", () => ({
  useShellPermissions: () => ({ ready: permissions.ready, can: () => permissions.allowed }),
}))
vi.mock("../new-menu", () => ({
  NewMenu: ({ open }: { open: boolean }) => <div data-testid="new-menu" data-open={open} />,
}))

import { AppMain } from "../app-main"
import { openPaletteFrom } from "../palette/palette-events"

afterEach(() => {
  cleanup()
  permissions.ready = false
  permissions.allowed = false
  sidebar.setOpenMobile.mockReset()
  route.pathname = "/invoices"
})

const isOpen = () => screen.getByTestId("new-menu").getAttribute("data-open")

describe("app main new menu", () => {
  it("does not remember N pressed while the role is loading", () => {
    const { rerender } = render(<AppMain>page</AppMain>)
    fireEvent.keyDown(document.body, { key: "n" })

    permissions.ready = true
    permissions.allowed = true
    rerender(<AppMain>page</AppMain>)

    expect(isOpen()).toBe("false")
  })

  it("opens with N once the menu is available", () => {
    permissions.ready = true
    permissions.allowed = true
    render(<AppMain>page</AppMain>)

    fireEvent.keyDown(document.body, { key: "n" })
    expect(isOpen()).toBe("true")
  })

  it("closes an open menu when it stops being available", () => {
    permissions.ready = true
    permissions.allowed = true
    const { rerender } = render(<AppMain>page</AppMain>)
    fireEvent.keyDown(document.body, { key: "n" })
    expect(isOpen()).toBe("true")

    permissions.ready = false
    rerender(<AppMain>page</AppMain>)
    act(() => undefined)
    permissions.ready = true
    rerender(<AppMain>page</AppMain>)

    expect(isOpen()).toBe("false")
  })

  it("ignores N for a member who can create nothing", () => {
    permissions.ready = true
    permissions.allowed = false
    render(<AppMain>page</AppMain>)

    fireEvent.keyDown(document.body, { key: "n" })
    expect(isOpen()).toBe("false")
  })

  it("closes the mobile drawer when the palette navigates", () => {
    render(<AppMain>page</AppMain>)

    fireEvent.click(screen.getByRole("button", { name: "navigate" }))
    expect(sidebar.setOpenMobile).toHaveBeenCalledWith(false)
  })
})

describe("app main on Overblik", () => {
  it("shows no search of its own, and opens the palette with what the command bar was given", () => {
    route.pathname = "/"
    render(<AppMain>page</AppMain>)
    expect(screen.queryByTestId("search-field")).toBeNull()

    act(() => openPaletteFrom({ from: document.body, query: "bi" }))

    expect(screen.getByTestId("palette").getAttribute("data-open")).toBe("true")
    expect(screen.getByTestId("palette").getAttribute("data-query")).toBe("bi")
  })

  it("keeps the search field everywhere else", () => {
    render(<AppMain>page</AppMain>)
    expect(screen.getByTestId("search-field")).not.toBeNull()
  })
})
