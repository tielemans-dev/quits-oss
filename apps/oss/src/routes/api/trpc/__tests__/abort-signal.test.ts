import { beforeEach, expect, it, vi } from "vitest"
import { Route } from "../$"

const downstream = vi.hoisted(() => vi.fn<(signal?: AbortSignal) => Promise<string>>())
vi.mock("@tanstack/react-router", () => ({ createFileRoute: () => (options: unknown) => options }))
vi.mock("../../../../lib/auth", () => ({ auth: { api: { getSession: async () => null } } }))
vi.mock("../../../../lib/db", () => ({ prisma: {} }))
vi.mock("../../../../trpc/router", async () => {
  const { publicProcedure, router } = await import("../../../../trpc/init")
  return { appRouter: router({
    query: publicProcedure.query(({ ctx }) => downstream(ctx.request?.signal)),
    mutation: publicProcedure.mutation(({ ctx }) => downstream(ctx.request?.signal)),
  }) }
})

const handlers = (Route as unknown as { server: { handlers: Record<string, (input: { request: Request }) => Promise<Response>> } }).server.handlers

function createRequest(method: string, signal?: AbortSignal) {
  return new Request(`http://localhost/api/trpc/${method === "GET" ? "query" : "mutation"}`, {
    method, signal, headers: { "content-type": "application/json" },
    body: method === "POST" ? JSON.stringify({ json: null }) : undefined,
  })
}

beforeEach(() => { downstream.mockReset() })

it.each(["GET", "POST"])("aborts downstream work when a %s request is cancelled", async method => {
  const controller = new AbortController()
  const request = createRequest(method, controller.signal)
  let start!: () => void
  const started = new Promise<void>(resolve => { start = resolve })
  let finish!: () => void
  const aborted = vi.fn()
  downstream.mockImplementation(signal => new Promise((resolve, reject) => {
    const onAbort = () => { aborted(signal?.reason); reject(signal?.reason) }
    finish = () => { signal?.removeEventListener("abort", onAbort); resolve("finished") }
    signal?.addEventListener("abort", onAbort, { once: true })
    start()
  }))

  const response = handlers[method]!({ request })
  await Promise.race([started, response.then(() => { throw new Error("Request completed before downstream work started") })])
  controller.abort()
  try {
    expect(downstream).toHaveBeenCalledWith(request.signal)
    expect(aborted).toHaveBeenCalledWith(controller.signal.reason)
    const result = await response
    expect(result.ok).toBe(false)
    expect(await result.json()).toMatchObject({ error: { json: {
      message: controller.signal.reason.message,
    } } })
  } finally {
    finish()
    await response
  }
})

it.each(["GET", "POST"])("preserves successful %s responses when the request is not cancelled", async method => {
  downstream.mockResolvedValue("finished")
  const request = createRequest(method)
  const response = await handlers[method]!({ request })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ result: { data: { json: "finished" } } })
  expect(downstream).toHaveBeenCalledWith(request.signal)
  expect(request.signal.aborted).toBe(false)
})

it.each(["GET", "POST"])("forwards an already-aborted %s signal before downstream work starts", async method => {
  const controller = new AbortController()
  controller.abort()
  const request = createRequest(method, controller.signal)
  const work = vi.fn(() => "finished")
  downstream.mockImplementation(async signal => {
    signal?.throwIfAborted()
    return work()
  })

  const response = await handlers[method]!({ request })

  expect(downstream).toHaveBeenCalledWith(request.signal)
  expect(work).not.toHaveBeenCalled()
  expect(response.ok).toBe(false)
  expect(await response.json()).toMatchObject({ error: { json: {
    message: controller.signal.reason.message,
  } } })
})
