import { randomUUID } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { prisma } from "../../lib/db"
import { translate } from "../../lib/i18n/translate"
import { deliver, EmailSendError } from "../../lib/email"
import { createTestOrganization, hasTestDatabase } from "../../test-utils/organization"
import { jobsRouter } from "../../trpc/routers/jobs"
import { sendReminderNow } from "../commands/reminders"
import { executeCommand } from "../execute"
import { MAX_JOB_ATTEMPTS, reclaimStaleJobs, registerJobHandler, runDueJobs } from "../jobs"
import { handleReminderBatch, REMINDER_BATCH_JOB } from "../reminder-jobs"

vi.mock("../../lib/email", async () => ({
  ...await vi.importActual<typeof import("../../lib/email")>("../../lib/email"), deliver: vi.fn(),
}))

describe.skipIf(!hasTestDatabase)("persistent reminder jobs", () => {
  const cleanups: Array<() => Promise<void>> = []
  beforeEach(() => {
    vi.stubEnv("EMAIL_PROVIDER", "resend")
    vi.stubEnv("RESEND_API_KEY", "test-key")
    vi.stubEnv("FROM_EMAIL", "sender@example.com")
    vi.mocked(deliver).mockReset().mockResolvedValue({ id: "accepted" })
  })
  afterEach(async () => {
    vi.unstubAllEnvs()
    while (cleanups.length) await cleanups.pop()!()
  })
  async function setup(count = 2) {
    const org = await createTestOrganization({ roles: ["admin", "accountant"] })
    cleanups.push(org.cleanup)
    const contact = await prisma.contact.create({ data: { organizationId: org.organizationId, name: "Buyer", email: "buyer@example.com" } })
    const invoiceIds: string[] = []
    for (let i = 0; i < count; i++) invoiceIds.push((await prisma.invoice.create({ data: {
      organizationId: org.organizationId, contactId: contact.id, number: randomUUID(), status: "sent",
      dueDate: new Date("2026-01-01"), totalGross: "100", subtotalNet: "100",
    } })).id)
    const caller = (userId = org.actors.admin.userId) => jobsRouter.createCaller({ session: {
      user: { id: userId }, session: { activeOrganizationId: org.organizationId },
    } } as never)
    const api = caller()
    const request = { invoiceIds, clientRequestId: randomUUID() }
    const submissions = await Promise.all([api.sendReminders(request), api.sendReminders(request)])
    expect(submissions[0]).toEqual(submissions[1])
    const { jobId } = submissions[0]
    const sweep = async () => {
      await prisma.job.updateMany({ where: { organizationId: org.organizationId, type: REMINDER_BATCH_JOB, status: "pending" }, data: { runAfter: new Date(0) } })
      await runDueJobs({ organizationIds: [org.organizationId] })
      const job = await api.get({ jobId })
      expect(job.progress).toEqual({ total: job.steps.length,
        done: job.steps.filter(s => s.status === "succeeded" || s.status === "failed").length,
        succeeded: job.steps.filter(s => s.status === "succeeded").length,
        failed: job.steps.filter(s => s.status === "failed").length })
      return job
    }
    const finish = async () => {
      for (let i = 0; i < 15; i++) {
        const job = await sweep()
        if (job.status === "done" || job.status === "failed") return job
      }
      throw new Error("Job did not finish")
    }
    return { org, api, caller, jobId, invoiceIds, sweep, finish }
  }

  it("recovers a crash after sending but before storing the delivery key, without repeating completed steps", async () => {
    const ctx = await setup()
    const state = await ctx.api.get({ jobId: ctx.jobId })
    expect(state).toMatchObject({ title: "reminders.jobs.title", titleParams: { count: 2 } })
    expect(state.steps[0]).toMatchObject({ label: "reminders.jobs.step", labelParams: { customerName: "Buyer" } })
    expect(translate("reminders.jobs.title", "da", state.titleParams)).toBe("Send rykkere til 2 forfaldne fakturaer")
    expect(translate("reminders.jobs.title", "en", state.titleParams)).toBe("Send reminders to 2 overdue invoices")
    const first = state.steps[0]
    await executeCommand(sendReminderNow, { invoiceId: first.invoiceId }, {
      actor: ctx.org.actors.admin, clientRequestId: `job-step:${first.id}:1`,
    })
    await prisma.jobStep.update({ where: { id: first.id }, data: { status: "succeeded", attempts: 1 } })
    expect(deliver).toHaveBeenCalledTimes(1)
    // The second command commits its receipt and outbox. The runner dies before saving its key.
    const step = state.steps[1]
    await prisma.jobStep.update({ where: { id: step.id }, data: { status: "running", attempts: 1 } })
    expect((await executeCommand(sendReminderNow, { invoiceId: step.invoiceId }, {
      actor: ctx.org.actors.admin, clientRequestId: `job-step:${step.id}:1`,
    })).status).toBe("completed")
    await prisma.job.update({ where: { id: ctx.jobId }, data: { status: "running", claimToken: "dead-run", attempts: MAX_JOB_ATTEMPTS, updatedAt: new Date(Date.now() - 16 * 60_000) } })
    await reclaimStaleJobs(new Date(), { organizationIds: [ctx.org.organizationId] })
    expect(await ctx.api.get({ jobId: ctx.jobId })).toMatchObject({ status: "failed", progress: { done: 1, total: 2 } })
    await ctx.api.retryStep({ jobId: ctx.jobId, stepId: step.id })
    const done = await ctx.finish()
    expect(done).toMatchObject({ status: "done", progress: { done: 2, total: 2, succeeded: 2, failed: 0 } })
    expect(done.steps.map(s => s.attempts)).toEqual([1, 1])
    expect(done.successfulReminderInvoiceIds).toEqual(ctx.invoiceIds)
    expect(deliver).toHaveBeenCalledTimes(2)
    expect(await ctx.api.list()).toEqual([done])
    await ctx.sweep()
    expect(deliver).toHaveBeenCalledTimes(2)
  })

  it("reports a refusal as failed, retries only that step, and derives progress from rows", async () => {
    const ctx = await setup()
    vi.mocked(deliver).mockRejectedValueOnce(new EmailSendError("validation_error", "provider-secret"))
    const failed = await ctx.finish()
    expect(failed).toMatchObject({ status: "failed", progress: { done: 2, succeeded: 1, failed: 1 } })
    expect(failed.successfulReminderInvoiceIds).toEqual([ctx.invoiceIds[1]])
    expect(failed.steps[0].status).toBe("failed")
    expect(JSON.stringify(failed)).not.toContain("provider-secret")
    await expect(ctx.api.retryStep({ jobId: ctx.jobId, stepId: failed.steps[1].id })).rejects.toThrow("Only failed")
    await ctx.api.retryStep({ jobId: ctx.jobId, stepId: failed.steps[0].id })
    expect((await ctx.api.get({ jobId: ctx.jobId })).progress).toMatchObject({ done: 1, failed: 0 })
    const done = await ctx.finish()
    expect(done.steps.map(s => [s.status, s.attempts])).toEqual([["succeeded", 2], ["succeeded", 1]])
    expect(deliver).toHaveBeenCalledTimes(3)
  })

  it("backs off transient failures and recovers unfinished steps after exhausting attempts", async () => {
    const ctx = await setup(1)
    vi.stubEnv("RESEND_API_KEY", "")
    const first = await ctx.sweep()
    expect(first.steps[0]).toMatchObject({ status: "pending", attempts: 1 })
    const waiting = await prisma.job.findUniqueOrThrow({ where: { id: ctx.jobId } })
    expect(waiting.status).toBe("pending")
    expect(waiting.runAfter.getTime()).toBeGreaterThan(Date.now())
    for (let i = 1; i < MAX_JOB_ATTEMPTS; i++) await ctx.sweep()
    expect(await ctx.api.get({ jobId: ctx.jobId })).toMatchObject({ status: "failed", progress: { done: 0 } })
    vi.stubEnv("RESEND_API_KEY", "test-key")
    await ctx.api.retryStep({ jobId: ctx.jobId, stepId: first.steps[0].id })
    const done = await ctx.finish()
    expect(done).toMatchObject({ status: "done", progress: { done: 1, succeeded: 1 } })
    expect(done.steps[0].attempts).toBe(MAX_JOB_ATTEMPTS + 1)
    expect(deliver).toHaveBeenCalledTimes(1)
  })

  it("allows only one concurrent runner to claim a batch and rejects retry during that claim", async () => {
    const ctx = await setup(1)
    let release!: () => void, started!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const entered = new Promise<void>(resolve => { started = resolve })
    const handler = vi.fn(async (job: Parameters<typeof handleReminderBatch>[0]) => {
      started()
      await gate
      return handleReminderBatch(job)
    })
    registerJobHandler(REMINDER_BATCH_JOB, handler)
    const scope = { organizationIds: [ctx.org.organizationId], limit: 1 }
    const runners = Promise.all([runDueJobs(scope), runDueJobs(scope)])
    try {
      await entered
      const step = (await ctx.api.get({ jobId: ctx.jobId })).steps[0]
      await expect(ctx.api.retryStep({ jobId: ctx.jobId, stepId: step.id })).rejects.toThrow("currently running")
    } finally {
      release()
      await runners
      registerJobHandler(REMINDER_BATCH_JOB, handleReminderBatch)
    }
    expect(handler).toHaveBeenCalledTimes(1)
    expect((await runners).map(r => r.processed).sort()).toEqual([0, 1])
    expect((await ctx.finish()).steps[0].attempts).toBe(1)
    expect(deliver).toHaveBeenCalledTimes(1)
  })

  it.each([false, true])("handles a removed member with a committed receipt: %s", async committed => {
    const ctx = await setup(1)
    const step = (await ctx.api.get({ jobId: ctx.jobId })).steps[0]
    if (committed) {
      await prisma.jobStep.update({ where: { id: step.id }, data: { status: "running", attempts: 1 } })
      await executeCommand(sendReminderNow, { invoiceId: step.invoiceId }, {
        actor: ctx.org.actors.admin, clientRequestId: `job-step:${step.id}:1`,
      })
    }
    await prisma.member.deleteMany({ where: { organizationId: ctx.org.organizationId, userId: ctx.org.actors.admin.userId } })
    await runDueJobs({ organizationIds: [ctx.org.organizationId] })
    const state = await ctx.caller(ctx.org.actors.accountant.userId).get({ jobId: ctx.jobId })
    expect(state.steps[0].status).toBe(committed ? "succeeded" : "failed")
    expect(state.successfulReminderInvoiceIds).toEqual(committed ? ctx.invoiceIds : [])
    expect(deliver).toHaveBeenCalledTimes(committed ? 1 : 0)
  })

  it("scopes creation, reads and retries to the org and enforces send permission", async () => {
    const a = await setup(1), b = await setup(1)
    const step = (await a.api.get({ jobId: a.jobId })).steps[0]
    await expect(b.api.sendReminders({ invoiceIds: a.invoiceIds, clientRequestId: randomUUID() })).rejects.toThrow("not found")
    await expect(b.api.get({ jobId: a.jobId })).rejects.toThrow("not found")
    await expect(b.api.retryStep({ jobId: a.jobId, stepId: step.id })).rejects.toThrow("not found")
    await expect(b.api.retryStep({ jobId: b.jobId, stepId: step.id })).rejects.toThrow("Only failed")
    expect((await b.api.list()).map(j => j.id)).toEqual([b.jobId])
    await expect(a.caller(a.org.actors.accountant.userId).sendReminders({ invoiceIds: a.invoiceIds, clientRequestId: randomUUID() })).rejects.toThrow()
    expect(deliver).not.toHaveBeenCalled()
  })

  it("keeps queued delivery running, refuses uncertain retries, and fences an expired runner", async () => {
    const ctx = await setup(1)
    vi.mocked(deliver).mockRejectedValue(new EmailSendError("rate_limit_exceeded", "Try later"))
    const queued = await ctx.sweep()
    expect(queued.steps[0]).toMatchObject({ status: "running", attempts: 1 })
    expect(queued.successfulReminderInvoiceIds).toEqual([])
    expect(queued.progress.done).toBe(0)
    const step = await prisma.jobStep.findUniqueOrThrow({ where: { id: queued.steps[0].id } })
    await prisma.job.updateMany({ where: { dedupeKey: step.deliveryKey! }, data: { status: "failed", result: { outcome: "unconfirmed", message: "Delivery unconfirmed" } } })
    const failed = await ctx.finish()
    expect(failed.successfulReminderInvoiceIds).toEqual([])
    await expect(ctx.api.retryStep({ jobId: ctx.jobId, stepId: step.id })).rejects.toThrow("uncertain")
    await prisma.job.update({ where: { id: ctx.jobId }, data: { status: "running", claimToken: "expired", updatedAt: new Date(0) } })
    await reclaimStaleJobs(new Date(), { organizationIds: [ctx.org.organizationId] })
    await prisma.jobStep.update({ where: { id: step.id }, data: { status: "pending" } })
    const job = await prisma.job.findUniqueOrThrow({ where: { id: ctx.jobId } })
    await expect(handleReminderBatch({ ...job, claimToken: "expired" })).rejects.toThrow("claim lost")
    expect(deliver).toHaveBeenCalledTimes(1)
  })
})
