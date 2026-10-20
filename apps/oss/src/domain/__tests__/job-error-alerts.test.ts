import { beforeEach, describe, expect, it, vi } from "vitest"
import { authorizeRuntimeOperation, OperationDenied } from "../../lib/runtime/operation-policy"
import { MAX_JOB_ATTEMPTS, registerJobHandler, runJobsNow, TerminalJobError, WaitingJobError } from "../jobs"

const mocks = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), job: vi.fn(), update: vi.fn(), handler: vi.fn() }))
vi.mock("../../lib/observability", () => ({ appLogger: { child: () => mocks } }))
vi.mock("../../lib/db", () => ({ prisma: { job: { updateMany: mocks.update, findUniqueOrThrow: mocks.job } } }))
vi.mock("../../lib/runtime/operation-policy", () => ({ authorizeRuntimeOperation: vi.fn(), OperationDenied: class extends Error {} }))

describe("job failure severity", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.update.mockResolvedValue({ count: 1 })
    mocks.job.mockResolvedValue({ id: "job-1", organizationId: "org-1", type: "reminder.send", attempts: 1, payload: {} })
    registerJobHandler("reminder.send", mocks.handler)
  })

  it.each(["terminal", "exhausted"])("alerts for %s jobs", async reason => {
    if (reason === "exhausted") mocks.job.mockResolvedValue({ id: "job-1", organizationId: "org-1", type: "reminder.send", attempts: MAX_JOB_ATTEMPTS, payload: {} })
    mocks.handler.mockRejectedValue(reason === "terminal" ? new TerminalJobError("private") : new Error("private"))
    expect(await runJobsNow(["job-1"])).toMatchObject({ failed: 1 })
    expect(mocks.error).toHaveBeenCalledExactlyOnceWith("job.failed", expect.objectContaining({
      organizationId: "org-1", jobId: "job-1", type: "reminder.send", terminal: reason === "terminal", exhausted: reason === "exhausted",
    }))
    expect(JSON.stringify(mocks.error.mock.calls)).not.toContain("private")
  })

  it("keeps a retryable attempt at warning level and a waiting job quiet", async () => {
    mocks.handler.mockRejectedValueOnce(new Error("transient")).mockRejectedValueOnce(new WaitingJobError())
    expect(await runJobsNow(["job-1"])).toMatchObject({ retrying: 1, failed: 0 })
    expect(mocks.warn).toHaveBeenCalledTimes(1)
    await runJobsNow(["job-1"])
    expect(mocks.warn).toHaveBeenCalledTimes(1)
    expect(mocks.error).not.toHaveBeenCalled()
  })

  it("fails a job the policy refused past its limit at warning level, without running it", async () => {
    registerJobHandler("test.refused", mocks.handler, { policyDeferralLimitMs: 60_000 })
    mocks.job.mockResolvedValue({ id: "job-1", organizationId: "org-1", type: "test.refused", attempts: 1, payload: {}, createdAt: new Date(Date.now() - 60_000) })
    vi.mocked(authorizeRuntimeOperation).mockRejectedValue(new OperationDenied("private"))
    expect(await runJobsNow(["job-1"])).toMatchObject({ failed: 1, deferred: 0 })
    expect(mocks.update).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "failed", attempts: { decrement: 1 } }) }))
    expect(mocks.warn).toHaveBeenCalledExactlyOnceWith("job.refused", { organizationId: "org-1", jobId: "job-1", type: "test.refused" })
    expect(mocks.error).not.toHaveBeenCalled()
    expect(mocks.handler).not.toHaveBeenCalled()
  })
})
