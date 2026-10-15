import { TRPCError } from "@trpc/server"
import { z } from "zod"
import type { Prisma } from "../../../generated/prisma/client"
import { executeCommand } from "../../domain/execute"
import { jobTarget, queueReminderJob, REMINDER_BATCH_JOB, retryReminderStep, stepTarget } from "../../domain/reminder-jobs"
import { prisma } from "../../lib/db"
import type { TranslationKey } from "../../lib/i18n/messages"
import { authorizedProcedure, router } from "../init"
import { unwrapOutcome } from "../outcome"

const select = {
  id: true, type: true, title: true, status: true, createdAt: true, updatedAt: true,
  steps: {
    orderBy: { position: "asc" },
    select: { id: true, position: true, label: true, labelParams: true, invoiceId: true, status: true, error: true, attempts: true },
  },
} satisfies Prisma.JobSelect

function progress(job: Prisma.JobGetPayload<{ select: typeof select }>) {
  const succeeded = job.steps.filter(step => step.status === "succeeded")
  const failed = job.steps.filter(step => step.status === "failed").length
  return {
    ...job, kind: REMINDER_BATCH_JOB,
    title: "reminders.jobs.title" as const satisfies TranslationKey, titleParams: { count: job.steps.length },
    steps: job.steps.map(step => ({ ...step,
      label: "reminders.jobs.step" as const satisfies TranslationKey,
      labelParams: z.object({ customerName: z.string() }).catch({ customerName: "" }).parse(step.labelParams),
      error: step.error ? { code: "reminder_step_failed" as const, message: step.error } : null,
    })),
    progress: { done: succeeded.length + failed, total: job.steps.length, succeeded: succeeded.length, failed },
    successfulReminderInvoiceIds: succeeded.flatMap(step => step.invoiceId ? [step.invoiceId] : []),
  }
}

export const jobsRouter = router({
  sendReminders: authorizedProcedure("invoice:send")
    .input(queueReminderJob.input)
    .mutation(async ({ ctx, input }) =>
      unwrapOutcome(await executeCommand(queueReminderJob, input, { actor: ctx.actor, clientRequestId: input.clientRequestId }))),

  list: authorizedProcedure("invoice:read").query(async ({ ctx }) =>
    (await prisma.job.findMany({
      where: { organizationId: ctx.organizationId, type: REMINDER_BATCH_JOB },
      select, orderBy: { createdAt: "desc" }, take: 50,
    })).map(progress)),

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
