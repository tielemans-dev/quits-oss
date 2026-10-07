import { Effect } from "effect"
import type { Deliverable } from "../../../generated/prisma/client"
import { lockedAgreement } from "./issuance"
import { refuseWhileSending } from "../documents/document-delivery"
import { Forbidden, InvalidState, NotFound } from "../errors"
import { Command } from "../services"

/** The organization-scoped parent serializes every child mutation and approval check. */
export const lockedDeliverable = (input: { agreementId: string; id: string }) =>
  Effect.gen(function* () {
    const agreement = yield* lockedAgreement(input.agreementId)
    yield* refuseWhileSending("agreement", agreement)
    const line = agreement.deliverables.find((line) => line.id === input.id)
    if (!line)
      return yield* new NotFound({
        message: "Deliverable not found",
        entity: "deliverable",
        id: input.id,
      })
    return { agreement, line }
  })

export const requireFulfillment = (
  agreement: { status: string },
  line: Deliverable,
  depositAllowed = false,
) =>
  Effect.gen(function* () {
    if (agreement.status !== "accepted")
      return yield* new InvalidState({
        code: "not_accepted",
        message: "Fulfillment requires an accepted agreement",
      })
    if (line.isDeposit && !depositAllowed)
      return yield* new InvalidState({
        code: "deposit_line",
        message: "Deposit lines do not participate in fulfillment",
      })
  })
export const requireDelivery = (agreement: { status: string }, line: Deliverable) =>
  Effect.gen(function* () {
    yield* requireFulfillment(agreement, line)
    if (!["planned", "in_progress", "changes_requested"].includes(line.status))
      return yield* new InvalidState({
        code: "invalid_transition",
        message: "Only planned, in-progress or changes-requested work can be delivered",
      })
  })
export const requireUnbilled = (line: Deliverable) =>
  line.billingStatus === "unbilled"
    ? Effect.void
    : Effect.fail(
        new InvalidState({
          code: "not_unbilled",
          message:
            "Only unbilled deliverables can be reopened or cancelled. Release the draft line first.",
        }),
      )
export const humanOnly = Effect.gen(function* () {
  const { actor } = yield* Command
  if (actor.kind !== "user")
    return yield* new Forbidden({ message: "This action requires a person" })
})
export const clearedAcceptance = {
  acceptedAt: null,
  acceptedRevision: null,
  acceptedVia: null,
  acceptanceEvidenceNote: null,
} as const
export function acceptanceRecord(line: Deliverable) {
  return line.acceptedAt
    ? {
        acceptedAt: line.acceptedAt.toISOString(),
        acceptedRevision: line.acceptedRevision,
        acceptedVia: line.acceptedVia,
        acceptanceEvidenceNote: line.acceptanceEvidenceNote,
      }
    : null
}
