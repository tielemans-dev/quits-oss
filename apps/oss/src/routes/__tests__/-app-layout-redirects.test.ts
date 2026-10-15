// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  getAppLayoutSession: vi.fn(),
}))

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => options,
  redirect: (payload: unknown) => payload,
  Outlet: () => null,
}))
vi.mock("../../lib/auth-session", () => ({ getAppLayoutSession: state.getAppLayoutSession }))
// A browser has no runtime environment: its own build-time answer is always self-host, and the
// layout must follow what the server says instead.
vi.mock("../../lib/distribution", () => ({ isCloudDistribution: false, billingEnabled: false }))
vi.mock("../../lib/auth-client", () => ({ useSession: () => ({ data: null }) }))
vi.mock("../../lib/i18n/react", () => ({
  useI18n: () => ({ setLocale: vi.fn() }),
  I18nProvider: ({ children }: { children: unknown }) => children,
}))
vi.mock("../../trpc/client", () => ({ trpc: { settings: { get: { query: () => new Promise(() => undefined) } } } }))
vi.mock("../../components/app-sidebar", () => ({ AppSidebar: () => null }))
vi.mock("../../components/organization-changed-banner", () => ({ OrganizationChangedBanner: () => null }))
vi.mock("../../components/ui/sidebar", () => ({
  SidebarProvider: ({ children }: { children: unknown }) => children,
  SidebarTrigger: () => null,
}))

import { APP_LAYOUT_SESSION_REUSE_MS, invalidateAppLayoutSession } from "../../lib/app-layout-session"
import { Route } from "../_app"

const route = Route as unknown as {
  beforeLoad: (context: unknown) => Promise<unknown>
}

function layout(
  organizationId: string | null,
  cloudOnboardingComplete: boolean | null,
  distribution: "cloud" | "selfhost" = "cloud"
) {
  return {
    user: { id: "u_1", name: "U", email: "u@example.com", image: null },
    activeOrganizationId: organizationId,
    runtime: { distribution, billingEnabled: distribution === "cloud" },
    cloudOnboardingComplete,
  }
}

async function load(pathname: string, preload = false) {
  try {
    return await route.beforeLoad({ location: { pathname: pathname.split("?")[0], href: pathname, search: Object.fromEntries(new URLSearchParams(pathname.split("?")[1])) }, preload })
  } catch (redirect) {
    return redirect
  }
}

beforeEach(() => {
  invalidateAppLayoutSession()
  state.getAppLayoutSession.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("app layout redirects on a cloud server", () => {
  it("sends a signed-out visitor to login", async () => {
    state.getAppLayoutSession.mockResolvedValue({ ...layout(null, null), user: null })
    expect(await load("/settings")).toEqual({ href: "/login?redirect=%2Fsettings" })
  })

  it("keeps the full path, search and language when sending a signed-out visitor to login", async () => {
    state.getAppLayoutSession.mockResolvedValue({ ...layout(null, null), user: null })
    const result = await load("/invoices/new?customer=a%20b&lang=da") as { href: string }
    const url = new URL(result.href, "http://app.test")
    expect(url.pathname).toBe("/login")
    expect(url.searchParams.get("redirect")).toBe("/invoices/new?customer=a%20b&lang=da")
    expect(url.searchParams.get("lang")).toBe("da")
  })

  it("sends a signed-out visitor to the dashboard to a bare login", async () => {
    state.getAppLayoutSession.mockResolvedValue({ ...layout(null, null), user: null })
    expect(await load("/")).toEqual({ href: "/login" })
  })

  it("sends a user without an active organization to onboarding", async () => {
    state.getAppLayoutSession.mockResolvedValue(layout(null, null))
    expect(await load("/invoices")).toEqual({ href: "/onboarding?next=%2Finvoices" })
  })

  it("retains exact path, query and locale while requiring setup", async () => {
    state.getAppLayoutSession.mockResolvedValue(layout("org_1", false))
    const result = await load("/invoices?filter=a%20b&lang=da") as { href: string }
    expect(new URL(result.href, "http://app.test").searchParams.get("next")).toBe("/invoices?filter=a%20b&lang=da")
    expect(result.href).toContain("&lang=da")
  })

  it("resumes a safe carried target after completed cloud setup", async () => {
    state.getAppLayoutSession.mockResolvedValue(layout("org_1", true))
    expect(await load("/onboarding?next=%2Fhosted%2Faccount%3Ftab%3Dvat&lang=en"))
      .toEqual({ href: "/hosted/account?tab=vat&lang=en" })
  })

  it("does not loop when the carried target is onboarding itself", async () => {
    state.getAppLayoutSession.mockResolvedValue(layout("org_1", true))
    expect(await load("/onboarding?next=%2Fonboarding%3Flang%3Den")).toEqual({ to: "/" })
  })

  it("rejects an external carried target after completed setup", async () => {
    state.getAppLayoutSession.mockResolvedValue(layout("org_1", true))
    expect(await load("/onboarding?next=https%3A%2F%2Fevil.example")).toEqual({ to: "/" })
  })

  it("lets a user without an active organization stay on onboarding", async () => {
    state.getAppLayoutSession.mockResolvedValue(layout(null, null))
    expect(await load("/onboarding")).toHaveProperty("user")
  })

  it("sends an incomplete organization to cloud onboarding from an app page, in the browser", async () => {
    state.getAppLayoutSession.mockResolvedValue(layout("org_a", false))
    expect(await load("/invoices")).toEqual({ href: "/onboarding?next=%2Finvoices" })
  })

  it("keeps an incomplete organization on onboarding", async () => {
    state.getAppLayoutSession.mockResolvedValue(layout("org_a", false))
    expect(await load("/onboarding/company")).toHaveProperty("user")
  })

  it("sends a completed organization away from onboarding", async () => {
    state.getAppLayoutSession.mockResolvedValue(layout("org_a", true))
    expect(await load("/onboarding")).toEqual({ to: "/" })
  })

  it("lets a completed organization use app pages", async () => {
    state.getAppLayoutSession.mockResolvedValue(layout("org_a", true))
    expect(await load("/invoices")).toHaveProperty("user")
  })

  it("treats a missing onboarding status as incomplete", async () => {
    state.getAppLayoutSession.mockResolvedValue(layout("org_a", null))
    expect(await load("/invoices")).toEqual({ href: "/onboarding?next=%2Finvoices" })
  })

  it("hands the server's distribution to every page through the route context", async () => {
    state.getAppLayoutSession.mockResolvedValue(layout("org_a", true))
    expect(await load("/invoices")).toMatchObject({
      runtime: { distribution: "cloud", billingEnabled: true },
    })
  })
})

describe("app layout on a self-host server", () => {
  it("never redirects to cloud onboarding", async () => {
    state.getAppLayoutSession.mockResolvedValue(layout("org_a", null, "selfhost"))
    expect(await load("/invoices")).toHaveProperty("user")
    expect(await load("/onboarding")).toHaveProperty("user")
  })
})

describe("app layout server calls", () => {
  it("makes a single server call per navigation", async () => {
    state.getAppLayoutSession.mockResolvedValue(layout("org_a", true))
    await load("/invoices")
    expect(state.getAppLayoutSession).toHaveBeenCalledTimes(1)
  })

  it("reuses the answer for navigations and hover preloads inside the window", async () => {
    state.getAppLayoutSession.mockResolvedValue(layout("org_a", true))

    await load("/invoices", true)
    await load("/contacts", true)
    await load("/invoices")
    await load("/contacts")
    await load("/quotes")

    expect(state.getAppLayoutSession).toHaveBeenCalledTimes(1)
  })

  it("shares one request between a hover preload and the navigation started while it is in flight", async () => {
    let resolve: (value: unknown) => void = () => undefined
    state.getAppLayoutSession.mockReturnValue(new Promise((r) => (resolve = r)))

    const preload = load("/invoices", true)
    const navigation = load("/invoices")
    resolve(layout("org_a", true))
    await Promise.all([preload, navigation])

    expect(state.getAppLayoutSession).toHaveBeenCalledTimes(1)
  })

  it("shares a rejected preload with the click that follows, then drops it", async () => {
    let reject: (error: Error) => void = () => undefined
    state.getAppLayoutSession.mockReturnValueOnce(new Promise((_, r) => (reject = r)))

    const preload = load("/invoices", true)
    const click = load("/invoices")
    reject(new Error("offline"))
    const [preloaded, clicked] = await Promise.all([preload, click])

    // One request failed both of them alike; neither asked twice.
    expect(preloaded).toEqual(new Error("offline"))
    expect(clicked).toEqual(new Error("offline"))
    expect(state.getAppLayoutSession).toHaveBeenCalledTimes(1)

    // The failure was not remembered: the next navigation asks again and succeeds.
    state.getAppLayoutSession.mockResolvedValueOnce(layout("org_a", true))
    expect(await load("/invoices")).toHaveProperty("user")
    expect(state.getAppLayoutSession).toHaveBeenCalledTimes(2)
  })

  it("asks the server again after the window", async () => {
    vi.useFakeTimers()
    state.getAppLayoutSession.mockResolvedValue(layout("org_a", true))

    await load("/invoices")
    vi.advanceTimersByTime(APP_LAYOUT_SESSION_REUSE_MS + 1)
    await load("/contacts")

    expect(state.getAppLayoutSession).toHaveBeenCalledTimes(2)
  })

  it("sees a change straight away once the reuse is invalidated (sign-out, organization switch, onboarding)", async () => {
    state.getAppLayoutSession.mockResolvedValueOnce(layout("org_a", false))
    expect(await load("/invoices")).toEqual({ href: "/onboarding?next=%2Finvoices" })

    // Onboarding completed: the next navigation must not be sent back by the earlier answer.
    state.getAppLayoutSession.mockResolvedValueOnce(layout("org_a", true))
    invalidateAppLayoutSession()
    expect(await load("/invoices")).toHaveProperty("user")

    state.getAppLayoutSession.mockResolvedValueOnce({ ...layout(null, null), user: null })
    invalidateAppLayoutSession()
    expect(await load("/invoices")).toEqual({ href: "/login?redirect=%2Finvoices" })
    expect(state.getAppLayoutSession).toHaveBeenCalledTimes(3)
  })
})
