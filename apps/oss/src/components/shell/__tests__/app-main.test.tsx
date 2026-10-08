// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

const permissions = vi.hoisted(() => ({ ready: false, allowed: false }))

vi.mock("../../../lib/runtime-distribution", () => ({ useRuntimeDistribution: () => ({ billingEnabled: false }) }))
vi.mock("../../ui/sidebar", () => ({ SidebarTrigger: () => null }))
vi.mock("../search-field", () => ({ SearchField: () => null }))
vi.mock("../palette", () => ({ CommandPalette: () => null }))
vi.mock("../use-shell-permissions", () => ({
  useShellPermissions: () => ({ ready: permissions.ready, can: () => permissions.allowed }),
}))
vi.mock("../new-menu", () => ({
  NewMenu: ({ open }: { open: boolean }) => <div data-testid="new-menu" data-open={open} />,
}))

import { AppMain } from "../app-main"

afterEach(() => {
  cleanup()
  permissions.ready = false
  permissions.allowed = false
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
})
