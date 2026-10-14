import { afterEach, describe, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ enabled: false, dispatch: vi.fn(async () => new Response(null, { status: 200 })) }))
vi.mock("@tanstack/react-router", () => ({ createFileRoute: () => (options: unknown) => options }))
vi.mock("@trpc/server/adapters/fetch", () => ({ fetchRequestHandler: mocks.dispatch }))
vi.mock("../../lib/runtime/extensions", () => ({ getRuntimeCapabilities: () => ({ sellerVatConfirmation: { enabled: mocks.enabled } }) }))
vi.mock("../../trpc/router", () => ({ appRouter: {} }))
vi.mock("../../lib/auth", () => ({ auth: { api: { getSession: async () => null } } }))
vi.mock("../../trpc/init", () => ({ createRequestContext: () => ({}) }))
import { Route } from "../api/trpc/$"
const post = (Route as unknown as { server: { handlers: { POST: (input: { request: Request }) => Promise<Response> } } }).server.handlers.POST
afterEach(() => { mocks.enabled = false; mocks.dispatch.mockClear() })
describe("seller confirmation request boundary", () => {
  it.each([false, true])("keeps bounded regular app mutations available with the hosted flag %s", async enabled => {
    mocks.enabled = enabled
    const response = await post({ request: new Request("http://localhost/api/trpc/settings.update", { method: "POST", body: "{}" }) })
    expect(response.status).toBe(200)
    expect(mocks.dispatch).toHaveBeenCalledOnce()
  })
  it("rejects an oversized streamed hosted mutation before parsing/dispatch", async () => {
    mocks.enabled = true
    const response = await post({ request: new Request("http://localhost/api/trpc/settings.update", { method: "POST", body: new Uint8Array(4_194_305) }) })
    expect(response.status).toBe(413)
    expect(mocks.dispatch).not.toHaveBeenCalled()
  })
})
