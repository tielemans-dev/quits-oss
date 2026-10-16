import { invoiceSendInputSchema } from "@quits/contracts/invoices"
import { Effect } from "effect"
import { z } from "zod"
import type { Job } from "../../generated/prisma/client"
import { executeIssuanceCommand } from "../application/issuance"
import { getRuntimeCapabilities } from "../lib/runtime/extensions"
import { UNDO_HOLD_LEASE_MS, UNDO_WINDOW_MS } from "../lib/undo-window"
import type { UserActor } from "./actor"
import { defineCommand } from "./command"
import { deleteInvoiceDraft, sendInvoice } from "./commands/invoices"
import { InvalidState, NotFound } from "./errors"
import { registerJobHandler, TerminalJobError } from "./jobs"
import { REMINDER_BATCH_JOB, jobTarget } from "./reminder-jobs"
import { Command, Db } from "./services"
import { resolveUserActor } from "./user-actor"

export const DELAYED_INVOICE_SEND_JOB = "invoice.delayed_send"
const HELD_JOB_TYPES = [REMINDER_BATCH_JOB, DELAYED_INVOICE_SEND_JOB]

/** A job nothing has started on, still inside its undo window. */
export const heldJobWhere = (organizationId: string, now: Date) => ({
  organizationId, type: { in: HELD_JOB_TYPES }, status: "pending", claimToken: null, attempts: 0, runAfter: { gt: now },
})

const expired = () => new InvalidState({ code: "undo_expired", message: "The undo window has closed" })

/**
 * Queues the send of a draft invoice to run when the undo window closes. The send itself is the
 * ordinary `invoice.send`; the only thing this adds is the wait.
 */
export const queueDelayedInvoiceSend = defineCommand({
  type: "invoice.queue_delayed_send",
  permission: "invoice:send",
  outwardFacing: true,
  input: invoiceSendInputSchema,
  summarize: input => `Send invoice ${input.id} after the undo window`,
  handle: input => Effect.gen(function* () {
    const db = yield* Db
    const command = yield* Command
    if (command.actor.kind !== "user") return yield* new InvalidState({ code: "user_required", message: "A user must queue a send" })
    if (!getRuntimeCapabilities().emailDelivery.configured) return yield* new InvalidState({
      code: "email_unavailable", message: "Configure email delivery before sending emails. Nothing was queued.",
    })
    const invoice = yield* Effect.promise(() => db.invoice.findFirst({
      where: { id: input.id, organizationId: command.organizationId, status: "draft" }, select: { id: true },
    }))
    if (!invoice) return yield* new NotFound({ entity: "invoice", id: input.id, message: "Draft invoice not found" })
    const job = yield* Effect.promise(() => db.job.upsert({
      where: { dedupeKey: `invoice-send:${invoice.id}` },
      create: {
        organizationId: command.organizationId, type: DELAYED_INVOICE_SEND_JOB, dedupeKey: `invoice-send:${invoice.id}`,
        payload: { actor: command.actor, input }, runAfter: new Date(command.now.getTime() + UNDO_WINDOW_MS),
      },
      update: {},
    }))
    return { jobId: job.id }
  }),
})

/**
 * Fortryd for a held job: the job is removed before anything has run, and a send's draft goes with
 * it. Once the window has closed or a runner has claimed the job, it is refused and nothing changes.
 */
export const cancelHeldJob = defineCommand({
  type: "job.cancel_held",
  permission: "invoice:send",
  outwardFacing: true,
  input: jobTarget,
  summarize: () => "Take back a held send",
  handle: input => Effect.gen(function* () {
    const db = yield* Db
    const command = yield* Command
    const job = yield* Effect.promise(() => db.job.findFirst({ where: { id: input.jobId, ...heldJobWhere(command.organizationId, command.now) } }))
    if (!job) return yield* expired()
    const removed = yield* Effect.promise(() => db.job.deleteMany({ where: { id: job.id, status: "pending", claimToken: null } }))
    if (!removed.count) return yield* expired()
    if (job.type === DELAYED_INVOICE_SEND_JOB) yield* deleteInvoiceDraft.handle({ id: (job.payload as { input: { id: string } }).input.id })
    return { jobId: job.id }
  }),
})

/** Keeps a paused countdown's job held: it will run `remainingMs` from now unless held again. */
export const holdHeldJob = defineCommand({
  type: "job.hold_held",
  permission: "invoice:send",
  outwardFacing: false,
  input: jobTarget.extend({ remainingMs: z.number().int().min(0).max(UNDO_WINDOW_MS + UNDO_HOLD_LEASE_MS) }),
  summarize: () => "Keep a held send waiting",
  handle: input => Effect.gen(function* () {
    const db = yield* Db
    const command = yield* Command
    const moved = yield* Effect.promise(() => db.job.updateMany({
      where: { id: input.jobId, ...heldJobWhere(command.organizationId, command.now) },
      data: { runAfter: new Date(command.now.getTime() + input.remainingMs) },
    }))
    if (!moved.count) return yield* expired()
    return { jobId: input.jobId }
  }),
})

async function handleDelayedInvoiceSend(job: Pick<Job, "id" | "organizationId" | "payload">) {
  const { actor: saved, input } = job.payload as { actor: UserActor; input: unknown }
  const actor = await resolveUserActor({ organizationId: job.organizationId, userId: saved.userId, userName: saved.label }) ?? { ...saved, roles: [] }
  const outcome = await executeIssuanceCommand(sendInvoice, input, { actor, clientRequestId: `delayed-send:${job.id}` })
  if (outcome.status === "completed") return
  // The draft stays as it was; a refusal is not something retrying later would change.
  throw new TerminalJobError(outcome.status === "awaiting_approval" ? "Approval required" : outcome.error.message)
}

registerJobHandler(DELAYED_INVOICE_SEND_JOB, handleDelayedInvoiceSend)
