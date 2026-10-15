import { beforeEach, describe, expect, it, vi } from "vitest"
import { runReminderTask } from "../features/reminders"
import { runRecurringTick } from "../features/recurring"

const mocks = vi.hoisted(() => ({ error: vi.fn(), execute: vi.fn(), due: vi.fn(), schedule: vi.fn() }))
vi.mock("../../lib/observability", () => ({ appLogger: { child: () => mocks } }))
vi.mock("../../lib/db", () => ({ prisma: { recurringInvoice: { findMany: mocks.due, findUnique: mocks.schedule } } }))
vi.mock("../execute", () => ({ executeCommand: mocks.execute }))
vi.mock("../jobs", () => ({ registerJobHandler: vi.fn() }))
vi.mock("../commands/reminders", () => ({
  REMINDABLE_STATUSES: ["sent"], REMINDER_SEND_JOB: "reminder.send", deliverScheduledReminder: {}, scheduleDueReminders: {}, schedulerActor: vi.fn(),
}))
vi.mock("../commands/recurring", () => ({
  generateRecurringRun: {}, recordRecurringRunFailure: {}, recurringSystemActor: vi.fn(), runRequestId: vi.fn(),
}))
vi.mock("../scheduler", () => ({
  DEFAULT_ORGANIZATION_BUDGET: { timeBudgetMs: 30_000 }, organizationFilter: () => ({}), organizationSqlFilter: () => "",
  registerTickTask: vi.fn(), scannedOrganizationSource: vi.fn(),
  forEachOrganizationWithinBudget: async (_source: unknown, visit: (id: string) => Promise<void>) => {
    await visit("org-1")
    await visit("org-2")
    return { organizations: 2, deferred: 0 }
  },
}))

describe("scheduled failure alerts", () => {
  const now = new Date("2026-10-01")
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.due.mockResolvedValue([{ id: "schedule-1", organizationId: "org-1" }])
    mocks.schedule.mockResolvedValue({ status: "active", nextRunAt: now })
  })

  it("reports failed reminder outcomes and continues scheduling other organizations", async () => {
    mocks.execute.mockResolvedValueOnce({ status: "failed", error: { tag: "ExternalFailure", code: "unavailable", message: "private details" } })
      .mockResolvedValueOnce({ status: "completed", result: { scheduled: 1, skipped: 0 } })
    expect(await runReminderTask(now)).toMatchObject({ failed: 1, scheduled: 1 })
    expect(mocks.error).toHaveBeenCalledExactlyOnceWith("reminders.organization_failed", {
      organizationId: "org-1", status: "failed", errorTag: "ExternalFailure", code: "unavailable",
    })
  })

  it("reports a recurring provider failure while leaving it retryable", async () => {
    mocks.execute.mockResolvedValue({ status: "failed", error: { tag: "ExternalFailure", code: "renderer_down", message: "private details" } })
    expect(await runRecurringTick(now)).toMatchObject({ generated: 0, failed: 1 })
    expect(mocks.execute).toHaveBeenCalledTimes(1)
    expect(mocks.error).toHaveBeenCalledExactlyOnceWith("recurring.run_failed", {
      organizationId: "org-1", recurringInvoiceId: "schedule-1", runDate: now.toISOString(), errorTag: "ExternalFailure", code: "renderer_down",
    })
  })

  it.each(["run_not_due", "operation_not_allowed"])("does not alert on %s", async code => {
    mocks.execute.mockResolvedValue({ status: "failed", error: { tag: "InvalidState", code } })
    expect(await runRecurringTick(now)).toMatchObject({ failed: 0 })
    expect(mocks.error).not.toHaveBeenCalled()
  })
})
