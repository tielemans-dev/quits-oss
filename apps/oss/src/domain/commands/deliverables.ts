import { notifyDeliverable } from "../agreements/sign-off-notifications"
import { Effect } from "effect"
import { deliverableIdInputSchema, deliverableAcceptInputSchema } from "@quits/contracts/agreements"
import { defineCommand } from "../command"
import { Command, Db } from "../services"
import { InvalidState } from "../errors"
import {
  lockedDeliverable,
  requireFulfillment,
  requireDelivery,
  requireUnbilled,
  humanOnly,
  clearedAcceptance,
  acceptanceRecord,
} from "../agreements/fulfillment"

export const markDeliverableDelivered = defineCommand({
  type: "deliverable.mark_delivered",
  permission: "deliverable:deliver",
  outwardFacing: true,
  input: deliverableIdInputSchema,
  summarize: ({ id }) => `Mark deliverable ${id} delivered`,
  approvalContext: (input) =>
    Effect.gen(function* () {
      const command = yield* Command
      const { agreement, line } = yield* lockedDeliverable(input)
      // Validate before queuing. On execution, compare the reviewed version first,
      // then let the handler recheck eligibility under this same parent lock.
      if (!command.expectedApprovalVersion) yield* requireDelivery(agreement, line)
      return {
        summary: `Mark ${line.title} delivered for agreement ${agreement.number ?? agreement.title}`,
        version: `${line.id}:${line.status}:${line.deliveryRevision}:${agreement.issuedToEmail ?? ""}:${agreement.publicAccessKeyVersion}`,
        details: {
          recipient: agreement.issuedToEmail,
          agreementNumber: agreement.number,
          deliverableTitle: line.title,
          status: line.status,
          deliveryRevision: line.deliveryRevision,
        },
      }
    }),
  handle: (input) =>
    Effect.gen(function* () {
      const db = yield* Db
      const command = yield* Command
      const { agreement, line } = yield* lockedDeliverable(input)
      yield* requireDelivery(agreement, line)
      const delivered = yield* Effect.promise(() =>
        db.deliverable.update({
          where: { id: line.id },
          data: {
            status: "delivered",
            deliveryRevision: { increment: 1 },
            deliveredAt: command.now,
            ...clearedAcceptance,
            changeRequestNote: null,
          },
        }),
      )
      command.emit({
        aggregateType: "agreement",
        aggregateId: agreement.id,
        type: "deliverable.delivered",
        payload: {
          deliverableId: line.id,
          previousStatus: line.status,
          deliveryRevision: delivered.deliveryRevision,
          deliveredAt: command.now.toISOString(),
          previousAcceptance: acceptanceRecord(line),
        },
      })
      const notification = yield* notifyDeliverable(agreement, delivered, "delivered")
      return { ...delivered, signOffLink: notification.link, notificationDeliveryKey: notification.deliveryKey }
    }),
})

export const acceptDeliverable = defineCommand({
  type: "deliverable.accept",
  permission: "deliverable:accept",
  outwardFacing: false,
  input: deliverableAcceptInputSchema,
  summarize: ({ id }) => `Record acceptance of deliverable ${id}`,
  handle: (input) =>
    Effect.gen(function* () {
      yield* humanOnly
      const db = yield* Db
      const command = yield* Command
      const { agreement, line } = yield* lockedDeliverable(input)
      yield* requireFulfillment(agreement, line)
      if (line.status !== "delivered")
        return yield* new InvalidState({
          code: "invalid_transition",
          message: "Only delivered work can be accepted",
        })
      const accepted = yield* Effect.promise(() =>
        db.deliverable.update({
          where: { id: line.id },
          data: {
            status: "accepted",
            acceptedAt: command.now,
            acceptedRevision: line.deliveryRevision,
            acceptedVia: "internal",
            acceptanceEvidenceNote: input.evidenceNote,
          },
        }),
      )
      command.emit({
        aggregateType: "agreement",
        aggregateId: agreement.id,
        type: "deliverable.accepted",
        payload: {
          deliverableId: line.id,
          deliveryRevision: line.deliveryRevision,
          ...acceptanceRecord(accepted),
        },
      })
      return accepted
    }),
})

export const cancelDeliverable = defineCommand({
  type: "deliverable.cancel",
  permission: "deliverable:update",
  outwardFacing: false,
  input: deliverableIdInputSchema,
  summarize: ({ id }) => `Cancel deliverable ${id}`,
  handle: (input) =>
    Effect.gen(function* () {
      yield* humanOnly
      const db = yield* Db
      const command = yield* Command
      const { agreement, line } = yield* lockedDeliverable(input)
      yield* requireFulfillment(agreement, line, true)
      yield* requireUnbilled(line)
      if (line.status === "cancelled")
        return yield* new InvalidState({
          code: "invalid_transition",
          message: "The deliverable is already cancelled",
        })
      const cancelled = yield* Effect.promise(() =>
        db.deliverable.update({
          where: { id: line.id },
          data: { status: "cancelled" },
        }),
      )
      command.emit({
        aggregateType: "agreement",
        aggregateId: agreement.id,
        type: "deliverable.cancelled",
        payload: {
          deliverableId: line.id,
          previousStatus: line.status,
          deliveryRevision: line.deliveryRevision,
          acceptance: acceptanceRecord(line),
        },
      })
      return cancelled
    }),
})
export const deliverableCommands = [
  markDeliverableDelivered,
  acceptDeliverable,
  cancelDeliverable,
] as const
