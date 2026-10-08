// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"

const {
  search,
  loadPage,
  signInEmail,
  listOrganizations,
  setActiveOrganization,
  isCloudDistributionMock,
} = vi.hoisted(() => ({
  search: { value: {} as Record<string, string> },
  loadPage: vi.fn(),
  signInEmail: vi.fn(),
  listOrganizations: vi.fn(),
  setActiveOrganization: vi.fn(),
  isCloudDistributionMock: vi.fn(() => false),
}))

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({
    ...options,
    useSearch: () => search.value,
  }),
  Link: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock("../../lib/page-navigation", () => ({ loadPage, reloadPage: vi.fn() }))

vi.mock("../../lib/i18n/react", () => ({
  useI18n: () => ({
    t: (key: string) =>
      (
        {
          "auth.email": "Email",
          "auth.password": "Password",
          "auth.placeholder.email": "you@example.com",
          "auth.login.title": "Log in",
          "auth.login.description": "Enter your credentials to access your account",
          "auth.login.submit": "Sign in",
          "auth.login.submitting": "Signing in...",
          "auth.login.error": "Login failed",
          "auth.login.noAccount": "Don't have an account?",
          "auth.login.toSignup": "Sign up",
        } as const
      )[key] ?? key,
  }),
}))

// The distribution comes from the server's route context; these pages only read the resolved value.
vi.mock("../../lib/runtime-distribution", () => ({
  useRuntimeDistribution: () => {
    const isCloud = isCloudDistributionMock()
    return {
      distribution: isCloud ? "cloud" : "selfhost",
      billingEnabled: isCloud,
      isCloud,
      isSelfHost: !isCloud,
    }
  },
}))

vi.mock("../../lib/auth-client", () => ({
  authClient: {
    signIn: {
      email: signInEmail,
    },
    organization: {
      list: listOrganizations,
      setActive: setActiveOrganization,
    },
  },
}))

import { invalidateAppLayoutSession, reuseAppLayoutSession } from "../../lib/app-layout-session"
import { Route } from "../login"
import { asMockedRoute } from "../../test-utils/mocked-route"

const route = asMockedRoute(Route)
const RoutePage = route.component

afterEach(() => {
  cleanup()
  invalidateAppLayoutSession()
  loadPage.mockReset()
  search.value = {}
  signInEmail.mockReset()
  listOrganizations.mockReset()
  setActiveOrganization.mockReset()
  isCloudDistributionMock.mockReset()
  isCloudDistributionMock.mockReturnValue(false)
})

describe("LoginPage", () => {
  it("routes cloud users with one organization to onboarding after auto-select", async () => {
    isCloudDistributionMock.mockReturnValue(true)
    signInEmail.mockResolvedValue({ data: { user: { id: "user_1" } } })
    listOrganizations.mockResolvedValue({
      data: [
        {
          id: "org_1",
          name: "Org 1",
          slug: "org-1",
          createdAt: new Date("2026-03-09T00:00:00.000Z"),
        },
      ],
    })
    setActiveOrganization.mockResolvedValue({ data: { session: { activeOrganizationId: "org_1" } } })

    render(<RoutePage />)

    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "test@example.com" },
    })
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "password123" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }))

    await waitFor(() => {
      expect(setActiveOrganization).toHaveBeenCalledWith({ organizationId: "org_1" })
    })

    await waitFor(() => {
      expect(loadPage).toHaveBeenCalledWith("/onboarding")
    })
    expect(loadPage).toHaveBeenCalledTimes(1)
  })

  it("loads the requested page acting for the only organization", async () => {
    search.value = { redirect: "/invoices/inv_1" }
    signInEmail.mockResolvedValue({ data: { user: { id: "user_1" } } })
    listOrganizations.mockResolvedValue({
      data: [{ id: "org_1", name: "Org 1", slug: "org-1", createdAt: new Date("2026-03-09T00:00:00.000Z") }],
    })
    setActiveOrganization.mockResolvedValue({ data: { session: { activeOrganizationId: "org_1" } } })

    render(<RoutePage />)
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "test@example.com" } })
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "password123" } })
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }))

    await waitFor(() => {
      expect(loadPage).toHaveBeenCalledWith("/invoices/inv_1")
    })
    expect(setActiveOrganization).toHaveBeenCalledWith({ organizationId: "org_1" })
    expect(loadPage).toHaveBeenCalledTimes(1)
  })

  it("routes users with multiple orgs to onboarding so they can choose", async () => {
    signInEmail.mockResolvedValue({ data: { user: { id: "user_1" } } })
    listOrganizations.mockResolvedValue({
      data: [
        {
          id: "org_1",
          name: "Org 1",
          slug: "org-1",
          createdAt: new Date("2026-03-09T00:00:00.000Z"),
        },
        {
          id: "org_2",
          name: "Org 2",
          slug: "org-2",
          createdAt: new Date("2026-03-08T00:00:00.000Z"),
        },
      ],
    })

    render(<RoutePage />)

    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "test@example.com" },
    })
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "password123" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }))

    await waitFor(() => {
      expect(listOrganizations).toHaveBeenCalled()
    })

    expect(setActiveOrganization).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(loadPage).toHaveBeenCalledWith("/onboarding")
    })
  })

  it("drops the layout's cached session when signing in, so no earlier answer outlives the sign-in", async () => {
    signInEmail.mockResolvedValue({ data: { user: { id: "user_1" } } })
    listOrganizations.mockResolvedValue({ data: [] })
    const load = vi.fn(async () => ({ user: null as unknown, n: 1 }))
    load.mockResolvedValue({ user: { id: "earlier" }, n: 1 })
    await reuseAppLayoutSession(load)

    render(<RoutePage />)
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "test@example.com" } })
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "password123" } })
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }))
    await waitFor(() => {
      expect(signInEmail).toHaveBeenCalled()
    })
    await waitFor(() => {
      expect(loadPage).toHaveBeenCalled()
    })

    await reuseAppLayoutSession(load)
    expect(load).toHaveBeenCalledTimes(2)
  })
})
