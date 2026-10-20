// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import { isNotFound, isRedirect } from "@tanstack/react-router"
import type { ComponentType } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a>,
}))
import { Route as CustomersRoute } from "../customers.$"
import { Route as AppSplatRoute } from "../_app/$"
import { Route as DemoSplatRoute } from "../demo/$"
import { I18nProvider } from "../../lib/i18n/react"

type Options = { beforeLoad?: (input: { params: { _splat?: string } }) => void; loader?: () => void; notFoundComponent?: ComponentType }
const options = (route: unknown) => (route as { options: Options }).options
function thrown(run: () => void) {
  try { run() } catch (error) { return error as { options?: { href?: string } } }
  throw new Error("expected the route to throw")
}

afterEach(cleanup)
describe("unknown app paths", () => {
  it.each([
    ["", "/contacts"],
    ["new", "/contacts/new"],
    ["abc123", "/contacts/abc123"],
  ])("sends /customers/%s to %s, where customers live", (splat, href) => {
    const error = thrown(() => options(CustomersRoute).beforeLoad!({ params: { _splat: splat } }))
    expect(isRedirect(error)).toBe(true)
    expect(error.options?.href).toBe(href)
  })

  it("answers an unknown signed-in path with a 404 inside the app, in the organization's language", async () => {
    expect(isNotFound(thrown(() => options(AppSplatRoute).loader!()))).toBe(true)
    const NotFound = options(AppSplatRoute).notFoundComponent!
    render(<I18nProvider locale="da-DK"><NotFound /></I18nProvider>)
    expect(screen.getByRole("heading", { name: "Siden findes ikke" })).toBeTruthy()
    expect(screen.getByRole("link", { name: "Gå til forsiden" }).getAttribute("href")).toBe("/")
  })

  it("keeps unknown example paths a public 404 rather than a sign-in redirect", () => {
    expect(isNotFound(thrown(() => options(DemoSplatRoute).loader!()))).toBe(true)
  })
})
