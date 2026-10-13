import { renderToString } from "react-dom/server"
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router"
import { describe, expect, it, vi } from "vitest"
import { RuntimeUiProvider, useRuntimeUi } from "@quits/oss/runtime/ui"
import { getRouter } from "../../../router"

// Test-only route tree isolates router wrapping from application data loading.
vi.mock("../../../routeTree.gen", async () => {
  const { createRootRoute } = await import("@tanstack/react-router")
  return { routeTree: createRootRoute({ component: Probe }) }
})

function Probe() {
  const Component = useRuntimeUi().settingsCompanyDetails
  return Component ? <Component organizationId="org_test" locale="en-US" /> : <p>default</p>
}

describe("runtime UI provider", () => {
  it("isolates nested providers and leaves an omitted extension empty", () => {
    const html = renderToString(
      <RuntimeUiProvider value={{ settingsCompanyDetails: () => <p>outer</p> }}>
        <Probe />
        <RuntimeUiProvider><Probe /></RuntimeUiProvider>
        <Probe />
      </RuntimeUiProvider>
    )
    expect(html).toBe("<p>outer</p><p>default</p><p>outer</p>")
    expect(renderToString(<Probe />)).toBe("<p>default</p>")
  })

  it("keeps independently configured router trees isolated across server renders", async () => {
    const first = getRouter({ runtimeUi: { settingsCompanyDetails: () => <p>first</p> } })
    const second = getRouter({ runtimeUi: { settingsCompanyDetails: () => <p>second</p> } })
    const baseline = getRouter()
    for (const router of [first, second, baseline]) {
      router.update({ history: createMemoryHistory({ initialEntries: ["/"] }) })
      await router.load()
    }
    expect(renderToString(<RouterProvider router={first} />)).toContain("<p>first</p>")
    expect(renderToString(<RouterProvider router={second} />)).toContain("<p>second</p>")
    expect(renderToString(<RouterProvider router={baseline} />)).toContain("<p>default</p>")
    expect(renderToString(<RouterProvider router={first} />)).toContain("<p>first</p>")
  })
})
