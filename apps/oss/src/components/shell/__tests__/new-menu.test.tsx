// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}))
vi.mock("../../../lib/i18n/react", () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock("../../ui/dropdown-menu", () => ({
  DropdownMenu: ({ children, open }: { children: ReactNode; open: boolean }) => (
    <div data-open={open}>{children}</div>
  ),
  DropdownMenuTrigger: ({ children, disabled }: { children: ReactNode; disabled?: boolean }) => (
    <button type="button" disabled={disabled}>
      {children}
    </button>
  ),
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuLabel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children }: { children: ReactNode }) => <div role="menuitem">{children}</div>,
}))

import { NewMenu } from "../new-menu"

afterEach(cleanup)

describe("new menu", () => {
  it("lists what the member may create, each as a link to its create page", () => {
    render(<NewMenu open onOpenChange={() => undefined} can={() => true} ready />)

    const links = screen.getAllByRole("link")
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/invoices/new",
      "/quotes/new",
      "/contacts/new",
      "/agreements/new",
    ])
  })

  it("gives every entry its own icon", () => {
    render(<NewMenu open onOpenChange={() => undefined} can={() => true} ready />)
    const icons = screen.getAllByRole("link").map((link) => link.querySelector("svg")?.getAttribute("class"))
    expect(icons.every(Boolean)).toBe(true)
    expect(new Set(icons.map((icon) => icon?.match(/lucide-[a-z0-9-]+/)?.[0])).size).toBe(4)
  })

  it("leaves out what the member may not create", () => {
    render(<NewMenu open onOpenChange={() => undefined} can={(action) => action === "quote:create"} ready />)
    expect(screen.getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual(["/quotes/new"])
  })

  it("has no button for a member who can create nothing, such as an accountant", () => {
    render(<NewMenu open onOpenChange={() => undefined} can={() => false} ready />)
    expect(screen.queryByRole("button")).toBeNull()
  })

  it("keeps the button, disabled and shut, while the role is loading", () => {
    const { container } = render(<NewMenu open onOpenChange={() => undefined} can={() => false} ready={false} />)
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true)
    expect(container.firstElementChild?.getAttribute("data-open")).toBe("false")
  })
})
