import { Effect } from "effect"
import { z } from "zod"
import type { Job, Prisma } from "../../generated/prisma/client"
import { prisma } from "../lib/db"
import type { UserActor } from "./actor"
import { defineCommand } from "./command"
import { sendReminderNow } from "./commands/reminders"
import { readDeliveryResult } from "./delivery/outbox"
import { InvalidState, NotFound } from "./errors"
import { executeCommand } from "./execute"
import { registerJobHandler, StaleJobClaimError, TerminalJobError, WaitingJobError } from "./jobs"
import { Command, Db } from "./services"
import { resolveUserActor } from "./user-actor"

export const REMINDER_BATCH_JOB = "reminders.batch"
export const jobTarget = z.object({ jobId: z.string().min(1) })
export const stepTarget = jobTarget.extend({ stepId: z.string().min(1) })

export const queueReminderJob = defineCommand({
  type: "reminder.queue_batch",
  permission: "invoice:send",
  outwardFacing: true,
  input: z.object({ invoiceIds: z.array(z.string().min(1)).min(1).max(100) }),
  summarize: input => `Send reminders to ${input.invoiceIds.length} overdue invoices`,
  handle: input => Effect.gen(function* () {
    const db = yield* Db
    const command = yield* Command
    if (command.actor.kind !== "user") return yield* new InvalidState({
      code: "user_required", message: "A user must queue reminder batches",
    })
    const ids = [...new Set(input.invoiceIds)]
    const invoices = yield* Effect.promise(() => db.invoice.findMany({
      where: { id: { in: ids }, organizationId: command.organizationId,
        dueDate: { lt: command.now }, status: { in: ["sent", "viewed", "overdue"] } },
      include: { contact: { select: { name: true } } },
    }))
    if (invoices.length !== ids.length) return yield* new NotFound({ entity: "invoice", message: "Overdue invoices not found" })
    const job = yield* Effect.promise(() => db.job.create({ data: {
      organizationId: command.organizationId, type: REMINDER_BATCH_JOB,
      title: `Send reminders to ${ids.length} overdue invoices`, payload: { actor: command.actor },
      steps: { create: ids.map((invoiceId, position) => ({
        invoiceId, position, label: `Rykker til ${invoices.find(i => i.id === invoiceId)!.contact.name}`,
      })) },
    } }))
    return { jobId: job.id }
  }),
})

export const retryReminderStep = defineCommand({
  type: "reminder.retry_step",
  permission: "invoice:send",
  outwardFacing: true,
  input: stepTarget,
  summarize: () => "Retry a failed reminder step",
  handle: input => Effect.gen(function* () {
    const db = yield* Db
    const { organizationId } = yield* Command
    // Lock the parent before the step, as the runner does; never reset a live claim.
    const parent = yield* Effect.promise(() => db.job.updateMany({
      where: { id: input.jobId, organizationId, type: REMINDER_BATCH_JOB, claimToken: null },
      data: { status: "pending", attempts: 0, runAfter: new Date(), lastError: null },
    }))
    if (!parent.count) return yield* new NotFound({ entity: "job", message: "Job not found or currently running" })
    const step = yield* Effect.promise(() => db.jobStep.findFirst({
      where: { id: input.stepId, jobId: input.jobId, status: "failed" },
    }))
    if (!step) return yield* new InvalidState({ code: "not_failed", message: "Only failed steps can be retried" })
    if (step.deliveryKey) {
      const delivery = yield* Effect.promise(() => readDeliveryResult(step.deliveryKey!))
      if (delivery.outcome === "unconfirmed" || delivery.outcome === "pending") return yield* new InvalidState({
        code: "delivery_uncertain", message: "Delivery is uncertain and cannot be sent again",
      })
    }
    yield* Effect.promise(() => db.jobStep.update({
      where: { id: step.id }, data: { status: "pending", error: null, deliveryKey: null },
    }))
    return { jobId: input.jobId, stepId: step.id }
  }),
})

export async function handleReminderBatch(job: Pick<Job, "id" | "organizationId" | "payload"> & { claimToken: string }) {
  const owned = { id: job.id, organizationId: job.organizationId, claimToken: job.claimToken }
  const write = (id: string, data: Prisma.JobStepUpdateManyMutationInput) => prisma.$transaction(async tx => {
    // Fence step writes against lease reclamation, including a stalled command returning late.
    const parent = await tx.job.updateMany({ where: owned, data: { updatedAt: new Date() } })
    if (!parent.count) throw new StaleJobClaimError("Reminder batch claim lost")
    await tx.jobStep.updateMany({ where: { id, jobId: job.id }, data })
  })
  const scope = { jobId: job.id, job: { organizationId: job.organizationId } }
  const deadline = Date.now() + 30_000
  const steps = await prisma.jobStep.findMany({
    where: { ...scope, status: { in: ["pending", "running"] } }, orderBy: { position: "asc" },
  })
  for (const step of steps) {
    if (Date.now() >= deadline) break
    if (step.status === "pending") {
      await write(step.id, { status: "running", attempts: { increment: 1 } })
      step.attempts += 1
    }
    let key = step.deliveryKey
    if (!key) {
      const saved = (job.payload as { actor: UserActor }).actor
      // A committed receipt remains replayable even if membership was removed after sending.
      const actor = await resolveUserActor({
        organizationId: job.organizationId, userId: saved.userId, userName: saved.label,
      }) ?? { ...saved, roles: [] }
      const outcome = await executeCommand(sendReminderNow, { invoiceId: step.invoiceId }, {
        actor, clientRequestId: `job-step:${step.id}:${step.attempts}`,
      })
      if (outcome.status !== "completed") {
        await write(step.id, {
          status: "failed", error: outcome.status === "awaiting_approval" ? "Approval required" : outcome.error.message,
        })
        continue
      }
      key = outcome.result.deliveryKey
      await write(step.id, { deliveryKey: key })
    }
    const delivery = await readDeliveryResult(key)
    if (delivery.outcome !== "pending") await write(step.id, {
      status: delivery.outcome === "delivered" ? "succeeded" : "failed", error: delivery.message,
    })
  }
  if (await prisma.jobStep.count({ where: { ...scope, status: { in: ["pending", "running"] } } })) throw new WaitingJobError()
  if (await prisma.jobStep.count({ where: { ...scope, status: "failed" } })) throw new TerminalJobError("One or more reminder steps failed")
}

registerJobHandler(REMINDER_BATCH_JOB, handleReminderBatch)
