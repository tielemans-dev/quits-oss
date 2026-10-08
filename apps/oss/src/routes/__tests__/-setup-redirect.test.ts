import { describe, expect, it, vi } from "vitest"

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => options,
  redirect: (payload: unknown) => payload,
  useNavigate: () => vi.fn(),
}))
// A browser's own build-time answer is always self-host; the route must follow the server's.
vi.mock("../../lib/distribution", () => ({ isCloudDistribution: false, billingEnabled: false }))
vi.mock("../../components/setup/setup-wizard", () => ({ SetupWizard: () => null }))
vi.mock("../../trpc/client", () => ({ trpc: {} }))
vi.mock("../../lib/i18n/react", () => ({ useI18n: () => ({ t: (key: string) => key }) }))

import { Route } from "../setup"

const route = Route as unknown as { beforeLoad: (context: unknown) => unknown }

function enter(distribution: string) {
  try {
    return route.beforeLoad({ context: { installation: { distribution } } })
  } catch (redirect) {
    return redirect
  }
}

describe("setup route", () => {
  it("sends visitors to login when the server is cloud, even in a browser that cannot tell", () => {
    expect(enter("cloud")).toEqual({ to: "/login" })
  })

  it("lets self-host visitors through", () => {
    expect(enter("selfhost")).toBeUndefined()
  })
})
