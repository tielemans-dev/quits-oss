import { describe, expect, it } from "vitest"

import { pickTrackedJob, remindedInvoiceIds, trackerView, type TrackerJob } from "../reminder-tracker"

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

describe("pickTrackedJob", () => {
  const running = job(["running"], {}, "running")
  const finished = job(["succeeded"], { status: "done" }, "finished")
  const failed = job(["failed"], { status: "failed" }, "failed")
  const none = new Set<string>()

  it("restores the download of a completed VAT export after reload until dismissed", () => {
    const exported = { ...finished, kind: "vat.summary" }
    expect(pickTrackedJob([exported], none, none, now)?.id).toBe("finished")
    expect(pickTrackedJob([exported], none, new Set(["finished"]), now)).toBeUndefined()
  })

  it("shows a running job, also after a reload", () => {
    expect(pickTrackedJob([finished, running], none, none, now)?.id).toBe("running")
  })

  it("keeps a job finished in this tab until it is dismissed", () => {
    expect(pickTrackedJob([finished], new Set(["finished"]), none, now)?.id).toBe("finished")
    expect(pickTrackedJob([finished], new Set(["finished"]), new Set(["finished"]), now)).toBeUndefined()
  })

  it("does not bring back a job that finished before this page loaded", () => {
    expect(pickTrackedJob([finished], none, none, now)).toBeUndefined()
  })

  it("offers a retry for a recent failure after a reload, but not an old one", () => {
    expect(pickTrackedJob([failed], none, none, now)?.id).toBe("failed")
    const old = job(["failed"], { status: "failed", createdAt: new Date(now - 2 * 86_400_000) }, "old")
    expect(pickTrackedJob([old], none, none, now)).toBeUndefined()
  })
})
