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
      },
    })
  })
})
