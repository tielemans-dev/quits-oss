import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const collectOperationalStatus = vi.hoisted(() => vi.fn())
vi.mock("../../selfhost/recovery/status", () => ({ collectOperationalStatus, environmentHold: () => false }))
vi.mock("../../lib/db", () => ({ prisma: { $queryRawUnsafe: vi.fn(async () => []) } }))

import { Route } from "../api/cron/status"

const handlers = Route.options.server?.handlers as { GET: (context: { request: Request }) => Promise<Response> }
const status = handlers.GET
const request = (secret = "s3cret-value") => ({ request: new Request("http://localhost/api/cron/status", { headers: { authorization: `Bearer ${secret}` } }) })

describe("operational status route", () => {
  const previous = process.env.CRON_SECRET
  beforeEach(() => {
    process.env.CRON_SECRET = "s3cret-value"
    collectOperationalStatus.mockReset()
  })
  afterEach(() => {
    if (previous === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = previous
  })

  it("is guarded like the scheduler endpoints", async () => {
    expect((await status(request("wrong"))).status).toBe(401)
    expect(collectOperationalStatus).not.toHaveBeenCalled()
  })

  it("answers 200 with the report when nothing needs attention", async () => {
    collectOperationalStatus.mockResolvedValue({ ok: true, problems: [] })
    const response = await status(request())
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true })
  })

  it("answers 503 when something needs an operator, so a monitor can alert on it", async () => {
    collectOperationalStatus.mockResolvedValue({ ok: false, problems: [{ severity: "error", code: "scheduler_silent", message: "x" }] })
    const response = await status(request())
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ problems: [{ code: "scheduler_silent" }] })
  })
})
