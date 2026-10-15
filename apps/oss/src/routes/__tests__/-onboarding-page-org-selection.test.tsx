// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"

const {
  navigate,
  loadPage,
  useSessionMock,
  listOrganizations,
  setActiveOrganization,
  isCloudDistributionMock,
} = vi.hoisted(() => ({
  navigate: vi.fn(),
  loadPage: vi.fn(),
  useSessionMock: vi.fn(),
  listOrganizations: vi.fn(),
  setActiveOrganization: vi.fn(),
  isCloudDistributionMock: vi.fn(() => false),
}))

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ ...(options as object), useSearch: () => ({}) }),
  useNavigate: () => navigate,
}))

vi.mock("../../lib/page-navigation", () => ({ loadPage, reloadPage: vi.fn() }))

vi.mock("../../lib/i18n/react", () => ({
  I18nProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useI18n: () => ({
    locale: "en",
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
    organization: {
      list: listOrganizations,
      setActive: setActiveOrganization,
      create: vi.fn(),
      checkSlug: vi.fn(),
    },
  },
  useSession: useSessionMock,
}))

vi.mock("../../trpc/client", () => ({
  trpc: {
    cvr: { available: { query: vi.fn(async () => ({ enabled: false, suggestions: false })) }, setupAvailable: { query: vi.fn(async () => ({ enabled: false })) } },
    onboarding: {
      searchCvr: { query: vi.fn() },
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
        query: vi.fn(async () => ({})),
      },
    },
  },
}))

import { authClient } from "../../lib/auth-client"
import { trpc } from "../../trpc/client"

import { Route } from "../_app/onboarding"
import { asMockedRoute } from "../../test-utils/mocked-route"

const route = asMockedRoute(Route)
const RoutePage = route.component

afterEach(() => {
  vi.restoreAllMocks()
  cleanup()
  navigate.mockReset()
  loadPage.mockReset()
  useSessionMock.mockReset()
  listOrganizations.mockReset()
  setActiveOrganization.mockReset()
  isCloudDistributionMock.mockReset()
  isCloudDistributionMock.mockReturnValue(false)
})

describe("OnboardingPage org selection", () => {
  it("shows inactive lookup results without offering to create them", async () => {
    isCloudDistributionMock.mockReturnValue(true)
    useSessionMock.mockReturnValue({ data: { user: { id: "user", email: "test@example.test" }, session: { activeOrganizationId: null } } })
    listOrganizations.mockResolvedValue({ data: [] })
    vi.mocked(trpc.onboarding.searchCvr.query).mockResolvedValue({ available: true, companies: [{ cvr: "24256790", name: "Ceased ApS", address: "Testvej 1", active: false }] })
    render(<RoutePage />)
    const query = await screen.findByLabelText("auth.onboarding.lookup.query")
    fireEvent.change(query, { target: { value: "Ceased" } })
    fireEvent.submit(query.closest("form")!)
    const notice = await screen.findByText("cvr.inactive")
    expect((notice.closest("button") as HTMLButtonElement).disabled).toBe(true)
    expect(authClient.organization.create).not.toHaveBeenCalled()
  })
  it("selects the created organization even when tab-local storage is blocked", async () => {
    useSessionMock.mockReturnValue({ data: { user: { id: "user_1" }, session: { activeOrganizationId: null } } })
    listOrganizations.mockResolvedValue({ data: [] })
    vi.mocked(authClient.organization.checkSlug).mockResolvedValue({ data: { status: true }, error: null } as never)
    vi.mocked(authClient.organization.create).mockResolvedValue({ data: { id: "org_created" }, error: null } as never)
    setActiveOrganization.mockResolvedValue({ data: { id: "org_created" } })
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("Blocked", "SecurityError") })
    render(<RoutePage />)
    const name = await screen.findByLabelText("auth.onboarding.field.companyName")
    fireEvent.change(screen.getByLabelText("auth.onboarding.cvrLabel"), { target: { value: "24256790" } })
    fireEvent.change(name, { target: { value: "Acme" } })
    fireEvent.submit(name.closest("form")!)
    await waitFor(() => expect(setActiveOrganization).toHaveBeenCalledWith({ organizationId: "org_created" }))
    expect(loadPage).toHaveBeenCalledWith("/")
    expect(screen.queryByText("Failed to create organization")).toBeNull()
    expect(authClient.organization.create).toHaveBeenCalledTimes(1)
  })

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

    // A new page load acting for the organization, which continues onboarding in cloud.
    expect(loadPage).toHaveBeenCalledWith("/onboarding")
    expect(navigate).not.toHaveBeenCalled()
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
    expect(screen.queryByText("auth.onboarding.lookup.title")).toBeNull()
  })

  it("requires a CVR before creating a hosted organization for v2", async () => {
    isCloudDistributionMock.mockReturnValue(true)
    useSessionMock.mockReturnValue({ data: { user: { id: "user_1", email: "test@example.com" }, session: { activeOrganizationId: null } } })
    listOrganizations.mockResolvedValue({ data: [] })
    vi.mocked(trpc.cvr.setupAvailable.query).mockResolvedValueOnce({ enabled: true } as never)
    vi.mocked(authClient.organization.checkSlug).mockResolvedValue({ data: { status: true }, error: null } as never)
    vi.mocked(authClient.organization.create).mockResolvedValue({ data: { id: "org_created" }, error: null } as never)
    setActiveOrganization.mockResolvedValue({ data: { id: "org_created" } })
    render(<RoutePage />)
    fireEvent.click(await screen.findByRole("button", { name: "auth.onboarding.lookup.manual" }))
    const name = await screen.findByLabelText("auth.onboarding.field.companyName")
    fireEvent.change(screen.getByLabelText("auth.onboarding.cvrLabel"), { target: { value: "24256790" } })
    fireEvent.change(name, { target: { value: "Nordlys ApS" } })
    fireEvent.submit(name.closest("form")!)
    await waitFor(() => expect(setActiveOrganization).toHaveBeenCalledWith({ organizationId: "org_created" }))
    // The new organization continues in the v2 wizard (lookup, review, confirm), not the app.
    expect(loadPage).toHaveBeenCalledWith("/onboarding")
    expect(authClient.organization.create).toHaveBeenCalledWith(expect.objectContaining({ metadata: { cvr: "24256790", onboardingAutoSlug: expect.any(String) } }))
  })

  it("keeps v2 unknown with a retry instead of falling back to v1 when capabilities fail", async () => {
    isCloudDistributionMock.mockReturnValue(true)
    useSessionMock.mockReturnValue({ data: { user: { id: "user_1", email: "test@example.com" }, session: { activeOrganizationId: null } } })
    listOrganizations.mockResolvedValue({ data: [] })
    vi.mocked(trpc.cvr.setupAvailable.query)
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce({ enabled: true } as never)
    render(<RoutePage />)
    const retry = await screen.findByRole("button", { name: "onboardingV2.retry" })
    expect(screen.queryByText("auth.onboarding.lookup.title")).toBeNull()
    expect(screen.queryByLabelText("auth.onboarding.field.companyName")).toBeNull()
    fireEvent.click(retry)
    expect(await screen.findByLabelText("auth.onboarding.lookup.query")).toBeTruthy()
    expect(screen.getByText("auth.onboarding.lookup.title")).toBeTruthy()
  })

  it("keeps the v1 lookup card when v2 is enabled but CVR onboarding is unavailable", async () => {
    isCloudDistributionMock.mockReturnValue(true)
    useSessionMock.mockReturnValue({ data: { user: { id: "user_1", email: "test@example.com" }, session: { activeOrganizationId: null } } })
    listOrganizations.mockResolvedValue({ data: [] })
    vi.mocked(trpc.runtime.capabilities.query).mockResolvedValue({ onboardingV2: { enabled: true } } as never)
    vi.mocked(trpc.cvr.setupAvailable.query).mockResolvedValueOnce({ enabled: false } as never)
    render(<RoutePage />)
    expect(await screen.findByText("auth.onboarding.lookup.title")).toBeTruthy()
  })

  it("offers the retry when the capability lookup hangs instead of spinning forever", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      isCloudDistributionMock.mockReturnValue(true)
      useSessionMock.mockReturnValue({ data: { user: { id: "user_1", email: "test@example.com" }, session: { activeOrganizationId: null } } })
      listOrganizations.mockResolvedValue({ data: [] })
      vi.mocked(trpc.cvr.setupAvailable.query).mockReturnValueOnce(new Promise(() => {}) as never)
      render(<RoutePage />)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(await screen.findByRole("button", { name: "onboardingV2.retry" })).toBeTruthy()
      expect(screen.queryByText("auth.onboarding.lookup.title")).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it("starts a hosted organization from CVR lookup instead of a name and slug form", async () => {
    isCloudDistributionMock.mockReturnValue(true)
    useSessionMock.mockReturnValue({
      data: {
        user: { id: "user_1", email: "test@example.com" },
        session: { activeOrganizationId: null },
      },
    })
    listOrganizations.mockResolvedValue({ data: [] })

    render(<RoutePage />)

    expect(await screen.findByText("auth.onboarding.lookup.title")).toBeTruthy()
    expect(screen.queryByLabelText("Slug")).toBeNull()
    expect(screen.getByRole("button", { name: "auth.onboarding.lookup.manual" })).toBeTruthy()
  })

  it("starts self-hosted organization creation manually with no lookup detour", async () => {
    useSessionMock.mockReturnValue({ data: { user: { id: "user_1", email: "test@example.com" }, session: { activeOrganizationId: null } } })
    listOrganizations.mockResolvedValue({ data: [] })
    render(<RoutePage />)
    expect(await screen.findByLabelText("auth.onboarding.field.companyName")).toBeTruthy()
    expect(screen.queryByText("auth.onboarding.lookup.title")).toBeNull()
    expect(screen.queryByText("auth.onboarding.lookup.manualBack")).toBeNull()
  })

  it("shows the app's own message for an empty company name instead of the browser's English tooltip", async () => {
    useSessionMock.mockReturnValue({ data: { user: { id: "user_1", email: "test@example.com" }, session: { activeOrganizationId: null } } })
    listOrganizations.mockResolvedValue({ data: [] })
    render(<RoutePage />)
    const name = await screen.findByLabelText("auth.onboarding.field.companyName")
    const form = name.closest("form")!
    expect(form.noValidate).toBe(true)
    fireEvent.submit(form)
    expect((await screen.findByRole("alert")).textContent).toBe("validation.required")
    expect(name.getAttribute("aria-invalid")).toBe("true")
    expect(name.getAttribute("aria-describedby")).toBe("company-name-error")
    expect(authClient.organization.create).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText("auth.onboarding.cvrLabel"), { target: { value: "24256790" } })
    fireEvent.change(name, { target: { value: "Acme" } })
    expect(screen.queryByText("validation.required")).toBeNull()
    expect(name.getAttribute("aria-invalid")).toBeNull()
  })

  it("shows the app's own message for an empty or too short CVR lookup", async () => {
    isCloudDistributionMock.mockReturnValue(true)
    useSessionMock.mockReturnValue({ data: { user: { id: "user_1", email: "test@example.com" }, session: { activeOrganizationId: null } } })
    listOrganizations.mockResolvedValue({ data: [] })
    render(<RoutePage />)
    const query = await screen.findByLabelText("auth.onboarding.lookup.query")
    const form = query.closest("form")!
    expect(form.noValidate).toBe(true)
    fireEvent.submit(form)
    expect((await screen.findByRole("alert")).textContent).toBe("validation.required")
    expect(query.getAttribute("aria-describedby")).toBe("cvr-query-error")
    fireEvent.change(query, { target: { value: "ab" } })
    fireEvent.submit(form)
    expect((await screen.findByRole("alert")).textContent).toBe("validation.unknown")
    fireEvent.change(query, { target: { value: "abc" } })
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("loads a new page acting for the organization the user chooses", async () => {
    useSessionMock.mockReturnValue({
      data: {
        user: { id: "user_1", email: "test@example.com" },
        session: { activeOrganizationId: null },
      },
    })
    listOrganizations.mockResolvedValue({
      data: [
        { id: "org_1", name: "Northwind", slug: "northwind", createdAt: new Date("2026-03-09T00:00:00.000Z") },
        { id: "org_2", name: "Contoso", slug: "contoso", createdAt: new Date("2026-03-08T00:00:00.000Z") },
      ],
    })
    setActiveOrganization.mockResolvedValue({ data: { session: { activeOrganizationId: "org_2" } } })

    render(<RoutePage />)
    fireEvent.click(await screen.findByText("Contoso"))

    await waitFor(() => {
      expect(loadPage).toHaveBeenCalledWith("/")
    })
    expect(setActiveOrganization).toHaveBeenCalledWith({ organizationId: "org_2" })
    expect(navigate).not.toHaveBeenCalled()
  })

  it("stays on the chooser with the error when switching fails", async () => {
    useSessionMock.mockReturnValue({
      data: {
        user: { id: "user_1", email: "test@example.com" },
        session: { activeOrganizationId: null },
      },
    })
    listOrganizations.mockResolvedValue({
      data: [
        { id: "org_1", name: "Northwind", slug: "northwind", createdAt: new Date("2026-03-09T00:00:00.000Z") },
        { id: "org_2", name: "Contoso", slug: "contoso", createdAt: new Date("2026-03-08T00:00:00.000Z") },
      ],
    })
    setActiveOrganization.mockResolvedValue({ data: null, error: { message: "Not a member" } })

    render(<RoutePage />)
    fireEvent.click(await screen.findByText("Contoso"))

    expect((await screen.findByRole("alert")).textContent).toBe("Not a member")
    expect(loadPage).not.toHaveBeenCalled()
  })
})
