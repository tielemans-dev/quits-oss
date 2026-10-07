import { Effect } from "effect"
import { z } from "zod"
import { defineCommand } from "../command"
import { Command, Db } from "../services"
import { Forbidden, InvalidState } from "../errors"
import { lockedAgreement } from "../agreements/issuance"
import { requireFulfillment, acceptanceRecord } from "../agreements/fulfillment"
import { notifyDeliverable } from "../agreements/sign-off-notifications"
import { lockDocument } from "../documents/locks"
import { verifyAgreementPublicToken, getAgreementPublicSecret } from "../../lib/agreements/tokens"

const tokenInput = z.object({ token: z.string().min(1).max(4096) }).strict()
const invalid = () => new InvalidState({ code: "invalid", message: "This link is no longer valid" })
const decide = (input: { token: string; note?: string }, verb: "accept" | "request_changes") =>
  Effect.gen(function* () {
    const command = yield* Command
    const db = yield* Db
    if (command.actor.kind !== "system" || command.actor.reason !== "customer_link")
      return yield* new Forbidden({ message: "Customer sign-off requires a public link" })
    const payload = verifyAgreementPublicToken(input.token, getAgreementPublicSecret())
    if (!payload || payload.scope !== "sign_off") return yield* invalid()
    const agreement = yield* lockedAgreement(payload.agreementId)
    const line = agreement.deliverables.find(line => line.id === payload.deliverableId)
    if (!line || agreement.publicAccessKeyVersion !== payload.keyVersion || line.deliveryRevision !== payload.deliveryRevision)
      return yield* invalid()
    // Billing never blocks a customer decision, including a reserved or sending invoice.
    yield* requireFulfillment(agreement, line)
    if (line.status === "accepted" || line.status === "changes_requested") {
      if ((verb === "accept" && line.status === "accepted" && line.acceptedRevision === payload.deliveryRevision) ||
          (verb === "request_changes" && line.status === "changes_requested")) return { agreement, line }
      return yield* new InvalidState({ code: "already_decided", message: "This delivery already has a decision" })
    }
    if (agreement.lastEmailAttemptOutcome === "sending")
      return yield* new InvalidState({ code: "retry_later", message: "Please try again after delivery settles" })
    if (line.status !== "delivered" || command.now >= new Date(payload.exp)) return yield* invalid()
    const disputedInvoiceIds: string[] = []
    if (verb === "request_changes" && line.billingStatus === "reserved") {
      const invoices = yield* Effect.promise(() => db.invoice.findMany({
        where: { organizationId: command.organizationId, agreementId: agreement.id, status: "draft", items: { some: { deliverableId: line.id } } },
        orderBy: { id: "asc" }, select: { id: true },
      }))
      for (const invoice of invoices) {
        yield* lockDocument("invoice", invoice.id)
        yield* Effect.promise(() => db.invoice.update({ where: { id: invoice.id }, data: { disputed: true, disputedRevision: { increment: 1 } } }))
        disputedInvoiceIds.push(invoice.id)
      }
    }
    const updated = yield* Effect.promise(() => db.deliverable.update({
      where: { id: line.id },
      data: verb === "accept" ? { status: "accepted", acceptedAt: command.now, acceptedRevision: payload.deliveryRevision, acceptedVia: "customer_link", acceptanceEvidenceNote: null } : { status: "changes_requested", changeRequestNote: input.note! },
    }))
    if (verb === "accept") command.emit({
      aggregateType: "agreement", aggregateId: agreement.id, type: "deliverable.accepted",
      payload: { deliverableId: line.id, deliveryRevision: line.deliveryRevision, ...acceptanceRecord(updated) },
    })
    else command.emit({
      aggregateType: "agreement", aggregateId: agreement.id, type: "deliverable.changes_requested",
      payload: { deliverableId: line.id, deliveryRevision: line.deliveryRevision, note: input.note ?? "", disputedInvoiceIds },
    })
    yield* notifyDeliverable(agreement, updated, verb === "accept" ? "accepted" : "changes_requested")
    return { agreement, line: updated }
  })

/** Only the verified public dispatcher calls these; neither registry exposes attestations. */
export const publicAcceptDeliverable = defineCommand({
  type: "deliverable.public_accept", permission: "deliverable:accept", outwardFacing: false,
  input: tokenInput.extend({ confirmed: z.literal(true) }).strict(),
  summarize: () => "Customer accepts delivered work", handle: input => decide(input, "accept"),
})
export const publicRequestDeliverableChanges = defineCommand({
  type: "deliverable.public_request_changes", permission: "deliverable:accept", outwardFacing: false,
  input: tokenInput.extend({ note: z.string().trim().min(1).max(5000) }).strict(),
  summarize: () => "Customer requests changes to delivered work", handle: input => decide(input, "request_changes"),
})
