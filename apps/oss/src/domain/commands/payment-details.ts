import { Effect } from "effect"
import type { Prisma } from "../../../generated/prisma/client"
import { paymentDetailsInputSchema } from "@quits/contracts/payment-details"
import {
  paymentDetailsFromColumns,
  paymentDetailsSelect,
  paymentDetailsToColumns,
} from "../../lib/payment-details"
import { diffPaymentDetails, type PaymentDetailsChangedBy } from "../../lib/payment-details-audit"
import { defineCommand } from "../command"
import { lockArtifactOrganization } from "../documents/artifacts"
import {
  PAYMENT_DETAILS_CHANGED_JOB,
  PAYMENT_DETAILS_NOTIFICATION_DELAY_MS,
  type PaymentDetailsChangedJob,
} from "../payment-details-notification"
import { actorId, type Actor } from "../actor"
import { Command, Db } from "../services"

/**
 * Who made the change. A person's display name is whatever they chose, so a person is identified
 * by their account's email address and user id too; readers see "Name <email>".
 */
async function describeChangedBy(db: Prisma.TransactionClient, actor: Actor): Promise<PaymentDetailsChangedBy> {
  if (actor.kind === "user") {
    const user = await db.user.findUnique({ where: { id: actor.userId }, select: { name: true, email: true } })
    return { kind: "user", id: actor.userId, name: user?.name || actor.label, email: user?.email ?? null }
  }
  return { kind: actor.kind, id: actorId(actor), name: actor.label, email: null }
}

/**
 * Replaces the bank account and payment note printed on invoices. Changing where customers send
 * money is the most common invoice-fraud vector, so every real change is recorded as
 * `organization.payment_details_updated` with masked before/after values, and the owners and
 * admins are told by email (best effort, see `notifyPaymentDetailsChanged`). Saving the same
 * details again changes nothing and records nothing. Only the change-audit event and the job are
 * masked; the settings and the invoices issued afterwards hold the full account.
 */
export const updatePaymentDetails = defineCommand({
  type: "organization.update_payment_details",
  permission: "settings:update",
  outwardFacing: false,
  input: paymentDetailsInputSchema,
  summarize: () => "Update the payment details printed on invoices",
  handle: (input) =>
    Effect.gen(function* () {
      const db = yield* Db
      const command = yield* Command
      const where = { organizationId: command.organizationId }

      // The previous values are read under the organization's settings row lock, so two saves at
      // once each record the values the other left, not the same stale ones. `executeCommand` takes
      // this lock for every command already; taking it here keeps the guarantee local, and a second
      // lock in the same transaction costs nothing.
      yield* Effect.promise(() => lockArtifactOrganization(db, command.organizationId))
      const previous = yield* Effect.promise(() =>
        db.orgSettings.findUnique({ where, select: paymentDetailsSelect })
      )
      const columns = paymentDetailsToColumns(input)
      const saved = yield* Effect.promise(() =>
        db.orgSettings.upsert({
          where,
          update: columns,
          create: { ...where, ...columns },
          select: paymentDetailsSelect,
        })
      )
      const details = paymentDetailsFromColumns(saved)

      const changes = diffPaymentDetails(paymentDetailsFromColumns(previous), details)
      if (changes.length > 0) {
        const changedBy = yield* Effect.promise(() => describeChangedBy(db, command.actor))
        command.emit({
          aggregateType: "organization",
          aggregateId: command.organizationId,
          type: "organization.payment_details_updated",
          payload: { changes, changedBy },
        })
        const notification: PaymentDetailsChangedJob = {
          changedBy,
          changedAt: command.now.toISOString(),
          changes,
        }
        command.enqueue({
          type: PAYMENT_DETAILS_CHANGED_JOB,
          payload: notification,
          dedupeKey: `${PAYMENT_DETAILS_CHANGED_JOB}:${command.commandId}`,
          runAfter: new Date(command.now.getTime() + PAYMENT_DETAILS_NOTIFICATION_DELAY_MS),
        })
      }
      return details
    }),
})
