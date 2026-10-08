// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { createContext, useContext, type ReactNode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  sessionOrganizationId: "org_a",
  setActive: vi.fn(),
  signOut: vi.fn(),
  loadPage: vi.fn(),
}))

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }))
vi.mock("../../lib/auth-client", () => ({
  authClient: {
    signOut: state.signOut,
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
vi.mock("../../lib/page-navigation", () => ({ loadPage: state.loadPage, reloadPage: vi.fn() }))
vi.mock("../../lib/i18n/react", () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock("../ui/sidebar", () => ({
  SidebarMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SidebarMenuItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SidebarMenuButton: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  useSidebar: () => ({ isMobile: false }),
}))
const RadioGroupContext = createContext<(value: string) => void>(() => undefined)

vi.mock("../ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuLabel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuRadioGroup: ({
    children,
    value,
    onValueChange,
  }: {
    children: ReactNode
    value: string
    onValueChange: (value: string) => void
  }) => (
    <RadioGroupContext.Provider value={onValueChange}>
      <div role="radiogroup" data-value={value}>
        {children}
      </div>
    </RadioGroupContext.Provider>
  ),
  DropdownMenuRadioItem: function RadioItem({
    children,
    value,
  }: {
    children: ReactNode
    value: string
  }) {
    const select = useContext(RadioGroupContext)
    return (
      <button type="button" role="radio" data-value={value} onClick={() => select(value)}>
        {children}
      </button>
    )
  },
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

import { invalidateAppLayoutSession, reuseAppLayoutSession } from "../../lib/app-layout-session"
import { THEME_STORAGE_KEY, resetThemeForTesting } from "../../lib/theme"
import {
  getRequestOrganizationId,
  initializeRequestOrganizationId,
  resetRequestOrganizationForTesting,
} from "../../lib/active-organization"
import { UserMenu } from "../user-menu"

afterEach(() => {
  cleanup()
  window.localStorage.clear()
  document.documentElement.classList.remove("dark")
  resetThemeForTesting()
  invalidateAppLayoutSession()
  resetRequestOrganizationForTesting()
  state.sessionOrganizationId = "org_a"
  state.setActive.mockReset()
  state.signOut.mockReset()
  state.loadPage.mockReset()
})

function organizationButton(name: string) {
  return screen.getByText(name).closest("button") as HTMLButtonElement
}

describe("user menu organizations", () => {
  it("cannot select the organization this tab and the session both act for", async () => {
    initializeRequestOrganizationId("org_a")
    render(<UserMenu />)

    expect((await screen.findByText("Northwind")).closest("button")?.disabled).toBe(true)
    expect(organizationButton("Contoso").disabled).toBe(false)
  })

  it("switches with a full page load", async () => {
    initializeRequestOrganizationId("org_a")
    state.setActive.mockResolvedValue({ data: {}, error: null })
    render(<UserMenu />)

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
    render(<UserMenu />)

    // This tab still acts for Northwind, so it stays checked, but nothing is locked.
    expect((await screen.findByText("Northwind")).closest("button")?.disabled).toBe(false)
    const sessionOrganization = organizationButton("Contoso")
    expect(sessionOrganization.disabled).toBe(false)

    await act(async () => {
      fireEvent.click(sessionOrganization)
    })

    expect(state.setActive).toHaveBeenCalledWith({ organizationId: "org_b" })
    expect(state.loadPage).toHaveBeenCalledWith("/")
  })

  it("signs out with a full page load", async () => {
    initializeRequestOrganizationId("org_a")
    state.signOut.mockResolvedValue({ data: {} })
    render(<UserMenu />)

    const signOut = await screen.findByText("user.signOut")
    await act(async () => {
      fireEvent.click(signOut)
    })

    expect(state.signOut).toHaveBeenCalled()
    expect(state.loadPage).toHaveBeenCalledWith("/login")
  })

  it("offers system, light and dark, and applies the choice", async () => {
    initializeRequestOrganizationId("org_a")
    render(<UserMenu />)

    const group = await screen.findByRole("radiogroup")
    expect(group.dataset.value).toBe("system")
    expect(screen.getByText("user.theme")).toBeTruthy()
    expect(screen.getAllByRole("radio").map((radio) => radio.dataset.value)).toEqual([
      "system",
      "light",
      "dark",
    ])

    await act(async () => {
      fireEvent.click(screen.getByText("user.theme.dark"))
    })

    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark")
    expect(document.documentElement.classList.contains("dark")).toBe(true)
    expect(screen.getByRole("radiogroup").dataset.value).toBe("dark")

    await act(async () => {
      fireEvent.click(screen.getByText("user.theme.light"))
    })

    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light")
    expect(document.documentElement.classList.contains("dark")).toBe(false)
  })

  it("drops the layout's cached session when signing out, so no stale identity survives", async () => {
    initializeRequestOrganizationId("org_a")
    state.signOut.mockResolvedValue({ data: {} })
    const load = vi.fn(async () => ({ user: { id: "u_1" } }))
    await reuseAppLayoutSession(load)
    render(<UserMenu />)

    await act(async () => {
      fireEvent.click(await screen.findByText("user.signOut"))
    })
    await reuseAppLayoutSession(load)

    expect(load).toHaveBeenCalledTimes(2)
  })
})
