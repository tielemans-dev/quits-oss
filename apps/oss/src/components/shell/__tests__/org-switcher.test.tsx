// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  sessionOrganizationId: "org_a",
  setActive: vi.fn(),
  loadPage: vi.fn(),
  navigate: vi.fn(),
}))

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => state.navigate }))
vi.mock("../../../lib/auth-client", () => ({
  authClient: {
    organization: {
      setActive: state.setActive,
      list: async () => ({
        data: [
          { id: "org_a", name: "Northwind", slug: "northwind", createdAt: new Date() },
          { id: "org_b", name: "Contoso", slug: "contoso", createdAt: new Date() },
        ],
      }),
    },
  },
  useSession: () => ({
    data: {
      user: { name: "Ada Lovelace", email: "ada@example.com" },
      session: { activeOrganizationId: state.sessionOrganizationId },
    },
    isPending: false,
  }),
}))
vi.mock("../../../lib/page-navigation", () => ({ loadPage: state.loadPage, reloadPage: vi.fn() }))
vi.mock("../../../lib/i18n/react", () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock("../../ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <button type="button">{children}</button>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuLabel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuItem: ({
    children,
    disabled,
    onClick,
  }: {
    children: ReactNode
    disabled?: boolean
    onClick?: () => void
  }) => (
    <button type="button" disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
}))

import {
  getRequestOrganizationId,
  initializeRequestOrganizationId,
  resetRequestOrganizationForTesting,
} from "../../../lib/active-organization"
import { OrgSwitcher } from "../org-switcher"

afterEach(() => {
  cleanup()
  resetRequestOrganizationForTesting()
  state.sessionOrganizationId = "org_a"
  state.setActive.mockReset()
  state.loadPage.mockReset()
  state.navigate.mockReset()
})

function organizationButtons(name: string) {
  // The trigger shows the current organization too, so the menu entry is the last match.
  const matches = screen.getAllByText(name)
  return matches[matches.length - 1].closest("button") as HTMLButtonElement
}

describe("organization switcher", () => {
  it("names the organization this tab acts for in the trigger", async () => {
    initializeRequestOrganizationId("org_a")
    render(<OrgSwitcher />)

    expect((await screen.findAllByText("Northwind")).length).toBe(2)
    expect(screen.getAllByText("Contoso").length).toBe(1)
  })

  it("cannot select the organization this tab and the session both act for", async () => {
    initializeRequestOrganizationId("org_a")
    render(<OrgSwitcher />)

    await screen.findAllByText("Northwind")
    expect(organizationButtons("Northwind").disabled).toBe(true)
    expect(organizationButtons("Contoso").disabled).toBe(false)
  })

  it("switches with a full page load", async () => {
    initializeRequestOrganizationId("org_a")
    state.setActive.mockResolvedValue({ data: {}, error: null })
    render(<OrgSwitcher />)

    const other = await screen.findByText("Contoso")
    await act(async () => {
      fireEvent.click(other)
    })

    expect(state.setActive).toHaveBeenCalledWith({ organizationId: "org_b" })
    expect(state.loadPage).toHaveBeenCalledWith("/")
    expect(getRequestOrganizationId()).toBe("org_a")
  })

  it("lets the session's organization be selected when another tab switched to it", async () => {
    initializeRequestOrganizationId("org_a")
    state.sessionOrganizationId = "org_b"
    state.setActive.mockResolvedValue({ data: {}, error: null })
    render(<OrgSwitcher />)

    // This tab still acts for Northwind, so it stays checked, but nothing is locked.
    await screen.findAllByText("Northwind")
    expect(organizationButtons("Northwind").disabled).toBe(false)
    const sessionOrganization = organizationButtons("Contoso")
    expect(sessionOrganization.disabled).toBe(false)

    await act(async () => {
      fireEvent.click(sessionOrganization)
    })

    expect(state.setActive).toHaveBeenCalledWith({ organizationId: "org_b" })
    expect(state.loadPage).toHaveBeenCalledWith("/")
  })

  it("offers to create another organization", async () => {
    initializeRequestOrganizationId("org_a")
    render(<OrgSwitcher />)

    await act(async () => {
      fireEvent.click(await screen.findByText("user.createOrganization"))
    })

    expect(state.navigate).toHaveBeenCalledWith({ to: "/onboarding" })
  })
})
