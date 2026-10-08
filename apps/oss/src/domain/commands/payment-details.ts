import { Effect } from "effect"
import { paymentDetailsInputSchema } from "@quits/contracts/payment-details"
import {
  paymentDetailsFromColumns,
  paymentDetailsSelect,
  paymentDetailsToColumns,
} from "../../lib/payment-details"
import { diffPaymentDetails } from "../../lib/payment-details-audit"
import { defineCommand } from "../command"
import {
  PAYMENT_DETAILS_CHANGED_JOB,
  PAYMENT_DETAILS_NOTIFICATION_DELAY_MS,
  type PaymentDetailsChangedJob,
} from "../payment-details-notification"
import { Command, Db } from "../services"

/**
 * Replaces the bank account and payment note printed on invoices. Changing where customers send
 * money is the most common invoice-fraud vector, so every real change is recorded as
 * `organization.payment_details_updated` with masked before/after values, and the owners and
 * admins are told by email (best effort, see `notifyPaymentDetailsChanged`). Saving the same
 * details again changes nothing and records nothing.
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
        command.emit({
          aggregateType: "organization",
          aggregateId: command.organizationId,
          type: "organization.payment_details_updated",
          payload: { changes },
        })
        const notification: PaymentDetailsChangedJob = {
          changedBy: command.actor.label,
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
