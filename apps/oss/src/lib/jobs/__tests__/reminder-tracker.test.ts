import { describe, expect, it } from "vitest"

import { remindedInvoiceIds, trackerView, type TrackerJob } from "../reminder-tracker"

const now = Date.parse("2026-10-15T12:00:00Z")

function job(statuses: string[], overrides: Partial<TrackerJob> = {}, id = "job-1"): TrackerJob {
  return {
    id,
    status: "running",
    createdAt: new Date(now - 60_000),
    steps: statuses.map((status, index) => ({
      id: `${id}-step-${index}`, label: "reminders.jobs.step", labelParams: { customerName: `Kunde ${index}` },
      invoiceId: `inv-${id}-${index}`, status,
    })),
    ...overrides,
  }
}

describe("trackerView", () => {
  it("counts only succeeded steps, so the counter, the bar and the pills agree", () => {
    const view = trackerView(job(["succeeded", "running", "pending"]))
    expect(view).toMatchObject({ sent: 1, total: 3, phase: "running" })
    expect(view.percent).toBeCloseTo(33.33, 1)
    expect(view.steps.map((step) => step.state)).toEqual(["sent", "sending", "waiting"])
  })

  it("is done only when every step succeeded", () => {
    expect(trackerView(job(["succeeded", "succeeded"], { status: "done" }))).toMatchObject({ phase: "done", percent: 100 })
  })

  it("shows a failed step as failed, never as sent, and does not count it as progress", () => {
    const view = trackerView(job(["succeeded", "failed", "succeeded"], { status: "failed" }))
    expect(view).toMatchObject({ sent: 2, total: 3, phase: "failed" })
    expect(view.steps[1]!.state).toBe("failed")
  })

  it("keeps running while other steps are still in flight after one failed", () => {
    expect(trackerView(job(["failed", "running"])).phase).toBe("running")
  })

  it("reads the unfinished steps of a failed job as failed, since nothing will run them", () => {
    const view = trackerView(job(["succeeded", "pending", "running"], { status: "failed" }))
    expect(view.steps.map((step) => step.state)).toEqual(["sent", "failed", "failed"])
    expect(view.phase).toBe("failed")
  })
})

describe("remindedInvoiceIds", () => {
  it("includes only invoices whose step succeeded, across jobs", () => {
    const ids = remindedInvoiceIds([job(["succeeded", "failed", "running"]), job(["succeeded"], {}, "job-2")])
    expect([...ids].sort()).toEqual(["inv-job-1-0", "inv-job-2-0"])
  })
})
