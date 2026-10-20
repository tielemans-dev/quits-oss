// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { createContext, useContext, type ReactNode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  sessionOrganizationId: "org_a",
  setActive: vi.fn(),
  signOut: vi.fn(),
  loadPage: vi.fn(),
  navigate: vi.fn(),
  setLocale: vi.fn(),
  locale: "da-DK",
  location: { href: "/invoices", search: {} as Record<string, unknown> },
}))

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => state.navigate,
  useRouterState: ({ select }: { select: (routerState: { location: typeof state.location }) => unknown }) => select({ location: state.location }),
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}))
vi.mock("../../lib/runtime-distribution", () => ({ useRuntimeDistribution: () => ({ billingEnabled: false }) }))
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
vi.mock("../../lib/i18n/react", () => ({ useI18n: () => ({ t: (key: string) => key, locale: state.locale, setLocale: state.setLocale }) }))
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
  state.navigate.mockReset()
  state.setLocale.mockReset()
  state.locale = "da-DK"
  state.location = { href: "/invoices", search: {} }
  document.cookie = "quits-lang=; path=/; max-age=0"
})

const themeGroup = () => screen.getAllByRole("radiogroup")[1]!

describe("user menu", () => {
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

    await screen.findAllByRole("radiogroup")
    expect(themeGroup().dataset.value).toBe("system")
    expect(screen.getByText("user.theme")).toBeTruthy()
    expect(Array.from(themeGroup().querySelectorAll("[role=radio]"), (radio) => (radio as HTMLElement).dataset.value)).toEqual([
      "system",
      "light",
      "dark",
    ])

    await act(async () => {
      fireEvent.click(screen.getByText("user.theme.dark"))
    })

    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark")
    expect(document.documentElement.classList.contains("dark")).toBe(true)
    expect(themeGroup().dataset.value).toBe("dark")

    await act(async () => {
      fireEvent.click(screen.getByText("user.theme.light"))
    })

    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light")
    expect(document.documentElement.classList.contains("dark")).toBe(false)
  })

  it("switches the interface language and saves it for later pages", async () => {
    initializeRequestOrganizationId("org_a")
    render(<UserMenu />)

    const group = (await screen.findAllByRole("radiogroup"))[0]!
    expect(group.dataset.value).toBe("da")
    expect(screen.getByText("user.language")).toBeTruthy()
    await act(async () => {
      fireEvent.click(screen.getByText("English"))
    })

    expect(document.cookie).toContain("quits-lang=en")
    expect(state.setLocale).toHaveBeenCalledWith("en-US")
    expect(state.navigate).not.toHaveBeenCalled()
  })

  it("replaces a ?lang in the address with the new choice", async () => {
    initializeRequestOrganizationId("org_a")
    state.location = { href: "/onboarding?next=%2Finvoices&lang=da", search: { next: "/invoices", lang: "da" } }
    render(<UserMenu />)

    await act(async () => {
      fireEvent.click(await screen.findByText("English"))
    })

    expect(state.navigate).toHaveBeenCalledWith({ href: "/onboarding?next=%2Finvoices&lang=en", replace: true })
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
