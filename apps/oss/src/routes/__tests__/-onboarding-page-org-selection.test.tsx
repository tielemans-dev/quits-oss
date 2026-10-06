// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen, waitFor } from "@testing-library/react"

const {
  navigate,
  invalidate,
  useSessionMock,
  listOrganizations,
  setActiveOrganization,
  isCloudDistributionMock,
} = vi.hoisted(() => ({
  navigate: vi.fn(),
  invalidate: vi.fn(),
  useSessionMock: vi.fn(),
  listOrganizations: vi.fn(),
  setActiveOrganization: vi.fn(),
  isCloudDistributionMock: vi.fn(() => false),
}))

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => options,
  useNavigate: () => navigate,
  useRouter: () => ({ invalidate }),
}))

vi.mock("../../lib/i18n/react", () => ({
  useI18n: () => ({
    t: (key: string) =>
      (
        {
          "auth.onboarding.title": "Create your organization",
          "auth.onboarding.description": "Set up your workspace to start invoicing",
          "auth.onboarding.submit": "Create organization",
          "auth.onboarding.orgName": "Organization name",
          "auth.onboarding.slug": "Slug",
          "auth.onboarding.placeholder.orgName": "Acme Inc.",
          "auth.onboarding.placeholder.slug": "acme-inc",
          "auth.onboarding.slugHelp": "URL-friendly identifier for your organization",
          "auth.onboarding.error": "Failed to create organization",
        } as const
      )[key] ?? key,
  }),
}))

vi.mock("../../lib/distribution", () => ({
  get isCloudDistribution() {
    return isCloudDistributionMock()
  },
}))

vi.mock("../../lib/auth-client", () => ({
  authClient: {
    organization: {
      list: listOrganizations,
      setActive: setActiveOrganization,
      create: vi.fn(),
    },
  },
  useSession: useSessionMock,
}))

vi.mock("../../trpc/client", () => ({
  trpc: {
    onboarding: {
      getStatus: {
        query: vi.fn(),
      },
      saveDraft: {
        mutate: vi.fn(),
      },
      completeManual: {
        mutate: vi.fn(),
      },
    },
    runtime: {
      capabilities: {
        query: vi.fn(),
      },
    },
  },
}))

import { Route } from "../_app/onboarding"
import { asMockedRoute } from "../../test-utils/mocked-route"

const route = asMockedRoute(Route)
const RoutePage = route.component

afterEach(() => {
  cleanup()
  navigate.mockReset()
  invalidate.mockReset()
  useSessionMock.mockReset()
  listOrganizations.mockReset()
  setActiveOrganization.mockReset()
  isCloudDistributionMock.mockReset()
  isCloudDistributionMock.mockReturnValue(false)
})

describe("OnboardingPage org selection", () => {
  it("keeps cloud users on onboarding after auto-selecting their only org", async () => {
    isCloudDistributionMock.mockReturnValue(true)
    useSessionMock.mockReturnValue({
      data: {
        user: { id: "user_1", email: "test@example.com" },
        session: { activeOrganizationId: null },
      },
    })
    listOrganizations.mockResolvedValue({
      data: [
        {
          id: "org_1",
          name: "Northwind",
          slug: "northwind",
          createdAt: new Date("2026-03-09T00:00:00.000Z"),
        },
      ],
    })
    setActiveOrganization.mockResolvedValue({
      data: { session: { activeOrganizationId: "org_1" } },
    })

    render(<RoutePage />)

    await waitFor(() => {
      expect(setActiveOrganization).toHaveBeenCalledWith({ organizationId: "org_1" })
    })

    expect(invalidate).toHaveBeenCalled()
    expect(navigate).not.toHaveBeenCalledWith({ to: "/", replace: true })
  })

  it("shows an organization chooser when the user has multiple orgs and no active org", async () => {
    useSessionMock.mockReturnValue({
      data: {
        user: { id: "user_1", email: "test@example.com" },
        session: { activeOrganizationId: null },
      },
    })
    listOrganizations.mockResolvedValue({
      data: [
        {
          id: "org_1",
          name: "Northwind",
          slug: "northwind",
          createdAt: new Date("2026-03-09T00:00:00.000Z"),
        },
        {
          id: "org_2",
          name: "Contoso",
          slug: "contoso",
          createdAt: new Date("2026-03-08T00:00:00.000Z"),
        },
      ],
    })

    render(<RoutePage />)

    await waitFor(() => {
      expect(listOrganizations).toHaveBeenCalled()
    })

    expect(screen.getByText("Northwind")).toBeTruthy()
    expect(screen.getByText("Contoso")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Create organization" })).toBeTruthy()
  })
})
