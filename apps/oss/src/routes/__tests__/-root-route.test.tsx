// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest"

const { getInstallationStatus, redirect } = vi.hoisted(() => ({
  getInstallationStatus: vi.fn(),
  redirect: vi.fn((payload: unknown) => payload),
}))

vi.mock("@tanstack/react-router", () => ({
  HeadContent: () => null,
  Scripts: () => null,
  Link: () => null,
  redirect,
  useRouterState: vi.fn(),
  createRootRoute: (options: unknown) => options,
}))

vi.mock("../styles.css?url", () => ({
  default: "/styles.css",
}))

vi.mock("../../lib/installation", () => ({
  getInstallationStatus,
  normalizeInstallationStatus: (status: {
    isSetupComplete?: boolean
    distribution?: string
    setupVersion?: number
  } | null | undefined) => ({
    isSetupComplete: status?.isSetupComplete ?? false,
    distribution: status?.distribution ?? "selfhost",
    setupVersion: status?.setupVersion ?? 1,
    billingEnabled: false,
  }),
}))

vi.mock("../../lib/i18n/react", () => ({
  I18nProvider: ({ children }: { children: React.ReactNode }) => children,
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock("../../components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => children,
}))

import { forgetInstallationStatus } from "../../lib/installation-cache"
import { Route } from "../__root"
import { asMockedRoute } from "../../test-utils/mocked-route"

const route = asMockedRoute(Route)

describe("root route setup guard", () => {
  it("does not crash when installation status is missing", async () => {
    getInstallationStatus.mockResolvedValue(undefined)

    await expect(
      route.beforeLoad({
        location: { pathname: "/setup" },
      })
    ).resolves.toEqual({
      installation: {
        isSetupComplete: false,
        distribution: "selfhost",
        setupVersion: 1,
        billingEnabled: false,
      },
    })
  })
})

// The route throws a redirect; the mocked `redirect` returns its payload, which is what is thrown.
async function navigate(pathname: string) {
  try {
    return await route.beforeLoad({ location: { pathname } })
  } catch (thrown) {
    return thrown
  }
}

describe("root route installation check", () => {
  const complete = { isSetupComplete: true, distribution: "selfhost", setupVersion: 1 }

  it("does not ask the server again once setup is complete", async () => {
    getInstallationStatus.mockClear()
    getInstallationStatus.mockResolvedValue(complete)

    await route.beforeLoad({ location: { pathname: "/invoices" } })
    await route.beforeLoad({ location: { pathname: "/contacts" } })
    await route.beforeLoad({ location: { pathname: "/quotes" } })

    expect(getInstallationStatus).toHaveBeenCalledTimes(1)
  })

  it("redirects to setup while it is incomplete, and does not loop after the wizard completes", async () => {
    forgetInstallationStatus()
    getInstallationStatus.mockClear()

    getInstallationStatus.mockResolvedValue({ ...complete, isSetupComplete: false })
    expect(await navigate("/invoices")).toMatchObject({ to: "/setup" })
    expect(await navigate("/invoices")).toMatchObject({ to: "/setup" })
    expect(getInstallationStatus).toHaveBeenCalledTimes(2)

    // The wizard finishes and navigates to /login, then on to the app.
    getInstallationStatus.mockResolvedValue(complete)
    expect(await navigate("/login")).toHaveProperty("installation.isSetupComplete", true)
    expect(await navigate("/invoices")).toHaveProperty("installation.isSetupComplete", true)
  })
})
