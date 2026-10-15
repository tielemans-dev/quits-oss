import { TRPCError } from "@trpc/server"
import { z } from "zod"
import type { Prisma } from "../../../generated/prisma/client"
import { cancelHeldJob, DELAYED_INVOICE_SEND_JOB, heldJobWhere, holdHeldJob, queueDelayedInvoiceSend } from "../../domain/held-jobs"
import { executeCommand } from "../../domain/execute"
import { runOrganizationJobs } from "../../domain/scheduler"
import { jobTarget, queueReminderJob, REMINDER_BATCH_JOB, retryReminderStep, stepTarget } from "../../domain/reminder-jobs"
import { prisma } from "../../lib/db"
import type { TranslationKey } from "../../lib/i18n/messages"
import { invoiceSendInputSchema } from "@quits/contracts/invoices"
import { authorizedProcedure, router } from "../init"
import { unwrapOutcome } from "../outcome"
import { actorCan } from "../../domain/actor"
import { runJobsNow } from "../../domain/jobs"
import { queueVatExport, VAT_EXPORT_JOB } from "../../domain/vat-export-job"

const select = {
  id: true, type: true, title: true, status: true, createdAt: true, updatedAt: true, runAfter: true,
  steps: {
    orderBy: { position: "asc" },
    select: { id: true, position: true, label: true, labelParams: true, invoiceId: true, status: true, error: true, attempts: true },
  },
} satisfies Prisma.JobSelect

function progress(job: Prisma.JobGetPayload<{ select: typeof select }>) {
  const vat = job.type === VAT_EXPORT_JOB
  const heldForMs = job.status === "pending" ? Math.max(0, job.runAfter.getTime() - Date.now()) : 0
  const succeeded = job.steps.filter(step => step.status === "succeeded")
  const failed = job.steps.filter(step => step.status === "failed").length
  return {
    ...job, kind: vat ? VAT_EXPORT_JOB : REMINDER_BATCH_JOB, heldForMs,
    title: (vat ? "shell.request.title.vat" : "reminders.jobs.title") satisfies TranslationKey, titleParams: { count: job.steps.length },
    steps: job.steps.map(step => ({ ...step,
      label: vat ? step.label : "reminders.jobs.step" satisfies TranslationKey,
      labelParams: z.object({ customerName: z.string() }).catch({ customerName: "" }).parse(step.labelParams),
      error: step.error ? { code: "reminder_step_failed" as const, message: step.error } : null,
    })),
    progress: { done: succeeded.length + failed, total: job.steps.length, succeeded: succeeded.length, failed },
    successfulReminderInvoiceIds: succeeded.flatMap(step => step.invoiceId ? [step.invoiceId] : []),
  }
}

export const jobsRouter = router({
  exportVat: authorizedProcedure("export:read").input(queueVatExport.input).mutation(async ({ ctx, input }) => {
    const result = unwrapOutcome(await executeCommand(queueVatExport, input, { actor: ctx.actor, clientRequestId: input.clientRequestId }))
    await runJobsNow([result.jobId])
    return result
  }),
  vatDownload: authorizedProcedure("export:read").input(jobTarget).query(async ({ ctx, input }) => {
    const job = await prisma.job.findFirst({ where: { id: input.jobId, organizationId: ctx.organizationId, type: VAT_EXPORT_JOB, status: "done" }, select: { result: true } })
    if (!job) throw new TRPCError({ code: "NOT_FOUND", message: "Completed export not found" })
    return z.object({ filename: z.string(), csv: z.string() }).parse(job.result)
  }),
  sendReminders: authorizedProcedure("invoice:send")
    .input(queueReminderJob.input)
    .mutation(async ({ ctx, input }) =>
      unwrapOutcome(await executeCommand(queueReminderJob, input, { actor: ctx.actor, clientRequestId: input.clientRequestId }))),

  list: authorizedProcedure("invoice:read").query(async ({ ctx }) =>
    (await prisma.job.findMany({
      where: { organizationId: ctx.organizationId, type: { in: actorCan(ctx.actor, "export:read") ? [REMINDER_BATCH_JOB, VAT_EXPORT_JOB] : [REMINDER_BATCH_JOB] } },
      select, orderBy: { createdAt: "desc" }, take: 50,
    })).map(progress)),

  /** Sends still inside their undo window, with the time each has left, so a reload finds its toast again. */
  held: authorizedProcedure("invoice:read").query(async ({ ctx }) => {
    const jobs = await prisma.job.findMany({
      where: heldJobWhere(ctx.organizationId, new Date()), orderBy: { createdAt: "asc" },
      select: { id: true, type: true, runAfter: true, payload: true, _count: { select: { steps: true } } },
    })
    return jobs.map(job => ({
      id: job.id, type: job.type, steps: job._count.steps, heldForMs: Math.max(0, job.runAfter.getTime() - Date.now()),
      invoiceId: job.type === DELAYED_INVOICE_SEND_JOB ? (job.payload as { input: { id: string } }).input.id : null,
    }))
  }),

  sendInvoiceLater: authorizedProcedure("invoice:send")
    .input(invoiceSendInputSchema)
    .mutation(async ({ ctx, input }) =>
      unwrapOutcome(await executeCommand(queueDelayedInvoiceSend, input, { actor: ctx.actor, clientRequestId: `invoice.queue_delayed_send:${input.id}` }))),

  cancelHeld: authorizedProcedure("invoice:send")
    .input(jobTarget)
    .mutation(async ({ ctx, input }) => unwrapOutcome(await executeCommand(cancelHeldJob, input, { actor: ctx.actor }))),

  holdHeld: authorizedProcedure("invoice:send")
    .input(holdHeldJob.input)
    .mutation(async ({ ctx, input }) => unwrapOutcome(await executeCommand(holdHeldJob, input, { actor: ctx.actor }))),

  /**
   * The window has closed on the client: run what is due now instead of waiting for the next tick.
   * A job still inside its window is not due, so this can never send early.
   */
  release: authorizedProcedure("invoice:send")
    .input(jobTarget)
    .mutation(async ({ ctx, input }) => {
      await runOrganizationJobs([ctx.organizationId])
      const job = await prisma.job.findFirst({ where: { id: input.jobId, organizationId: ctx.organizationId }, select: { status: true, lastError: true } })
      return { status: job?.status ?? "gone", error: job?.lastError ?? null }
    }),

  get: authorizedProcedure("invoice:read").input(jobTarget).query(async ({ ctx, input }) => {
    const job = await prisma.job.findFirst({
      where: { id: input.jobId, organizationId: ctx.organizationId, type: REMINDER_BATCH_JOB }, select,
    })
    if (!job) throw new TRPCError({ code: "NOT_FOUND", message: "Job not found" })
    return progress(job)
  }),

  retryStep: authorizedProcedure("invoice:send")
    .input(stepTarget)
    .mutation(async ({ ctx, input }) =>
      unwrapOutcome(await executeCommand(retryReminderStep, input, { actor: ctx.actor }))),
})
