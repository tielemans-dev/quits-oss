import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const runSchedulerTick = vi.fn()
const runOverdueTask = vi.fn()

vi.mock("../../domain/scheduler-tasks", () => ({}))
vi.mock("../../domain/scheduler", () => ({ runSchedulerTick }))
vi.mock("../../domain/features/overdue", () => ({ runOverdueTask }))

import { Route as MarkOverdueRoute } from "../api/cron/mark-overdue"
import { Route as TickRoute } from "../api/cron/tick"

type Handler = (context: { request: Request }) => Promise<Response>
const tickHandlers = TickRoute.options.server?.handlers as { POST: Handler }
const markOverdueHandlers = MarkOverdueRoute.options.server?.handlers as { GET: Handler }
const tick = tickHandlers.POST
const markOverdue = markOverdueHandlers.GET

function request(path: string, secret = "s3cret-value") {
  return { request: new Request(`http://localhost${path}`, { headers: { authorization: `Bearer ${secret}` } }) }
}

describe("cron routes", () => {
  const previous = process.env.CRON_SECRET
  beforeEach(() => {
    process.env.CRON_SECRET = "s3cret-value"
    runSchedulerTick.mockReset()
    runOverdueTask.mockReset()
  })
  afterEach(() => {
    if (previous === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = previous
  })

  it("refuses to run with the public placeholder secret", async () => {
    process.env.CRON_SECRET = "change-me-in-production"
    const response = await tick(request("/api/cron/tick", "change-me-in-production"))
    expect(response.status).toBe(503)
    expect(await response.text()).toContain("placeholder")
    expect((await markOverdue(request("/api/cron/mark-overdue", "change-me-in-production"))).status).toBe(503)
    expect(runSchedulerTick).not.toHaveBeenCalled()
  })

  it("rejects a wrong secret", async () => {
    expect((await tick(request("/api/cron/tick", "wrong"))).status).toBe(401)
  })

  it("reports success when every task succeeded", async () => {
    runSchedulerTick.mockResolvedValue({ overdue: { marked: 1, failed: 0 }, jobs: { processed: 2 } })
    const response = await tick(request("/api/cron/tick"))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true, failedTasks: [] })
  })

  it("returns 500 with the partial results when a task failed", async () => {
    runSchedulerTick.mockResolvedValue({
      overdue: { marked: 1, failed: 0 },
      reminders: { error: "database unavailable" },
      recurring: { generated: 0, failed: 1 },
      jobs: { processed: 0 },
    })
    const response = await tick(request("/api/cron/tick"))
    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({
      ok: false,
      failedTasks: ["reminders", "recurring"],
      results: { overdue: { marked: 1 }, jobs: { processed: 0 } },
    })
  })

  it("reports overdue failures on the legacy endpoint", async () => {
    runOverdueTask.mockResolvedValue({ organizations: 2, marked: 3, failed: 1, remaining: 0 })
    const response = await markOverdue(request("/api/cron/mark-overdue"))
    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({ ok: false, marked: 3, failed: 1 })

    runOverdueTask.mockResolvedValue({ organizations: 2, marked: 3, failed: 0, remaining: 0 })
    expect((await markOverdue(request("/api/cron/mark-overdue"))).status).toBe(200)
  })
})
