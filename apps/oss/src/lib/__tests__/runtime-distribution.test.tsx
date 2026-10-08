// @vitest-environment jsdom

import { renderHook } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

const router = vi.hoisted(() => ({ context: undefined as unknown }))

vi.mock("@tanstack/react-router", () => ({
  useRouterState: ({ select }: { select: (state: unknown) => unknown }) =>
    select({ matches: [{ context: {} }, { context: router.context }] }),
}))
// What a browser sees: no runtime environment and no build-time variable, so the build-time
// constants say self-host even though the server is cloud.
vi.mock("../distribution", () => ({ isCloudDistribution: false, billingEnabled: false }))

import { resolveRuntimeDistribution, useRuntimeDistribution } from "../runtime-distribution"

afterEach(() => {
  router.context = undefined
})

describe("resolveRuntimeDistribution", () => {
  it("sees cloud when the server delivered cloud, whatever the browser's own constants say", () => {
    expect(resolveRuntimeDistribution({ runtime: { distribution: "cloud", billingEnabled: true } })).toEqual({
      distribution: "cloud",
      billingEnabled: true,
      isCloud: true,
      isSelfHost: false,
    })
  })

  it("sees self-host when the server delivered self-host", () => {
    expect(resolveRuntimeDistribution({ runtime: { distribution: "selfhost", billingEnabled: false } })).toMatchObject({
      isCloud: false,
      isSelfHost: true,
      billingEnabled: false,
    })
  })

  it("takes the distribution from the root route's installation outside the app layout", () => {
    expect(resolveRuntimeDistribution({ installation: { distribution: "cloud" } })).toMatchObject({
      isCloud: true,
      billingEnabled: false,
    })
  })

  it("takes billing from the root route's installation outside the app layout, not the browser's constants", () => {
    expect(
      resolveRuntimeDistribution({ installation: { distribution: "cloud", billingEnabled: true } })
    ).toMatchObject({ isCloud: true, billingEnabled: true })
    expect(
      resolveRuntimeDistribution({ installation: { distribution: "cloud", billingEnabled: false } })
    ).toMatchObject({ isCloud: true, billingEnabled: false })
  })

  it("prefers the layout's answer over the installation's", () => {
    expect(
      resolveRuntimeDistribution({
        runtime: { distribution: "cloud", billingEnabled: false },
        installation: { distribution: "selfhost" },
      })
    ).toMatchObject({ isCloud: true, billingEnabled: false })
  })

  it("falls back to the build-time constants when no route delivered a value", () => {
    expect(resolveRuntimeDistribution(undefined)).toMatchObject({ distribution: "selfhost", isCloud: false })
    expect(resolveRuntimeDistribution({ installation: { distribution: "bogus" } })).toMatchObject({ isCloud: false })
  })
})

describe("useRuntimeDistribution", () => {
  it("reads the deepest matched route's context in the browser", () => {
    router.context = { runtime: { distribution: "cloud", billingEnabled: true } }
    const { result } = renderHook(() => useRuntimeDistribution())
    expect(result.current).toMatchObject({ isCloud: true, billingEnabled: true })
  })
})
