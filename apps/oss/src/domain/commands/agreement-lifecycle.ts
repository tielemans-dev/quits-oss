import { acceptanceRecipients, publicAcceptancePreview } from "../../lib/agreements/acceptance-preview"
import { Effect } from "effect"
import { z } from "zod"
import { Prisma } from "../../../generated/prisma/client"
import {
  agreementIdInputSchema,
  agreementIssueInputSchema,
  agreementResendInputSchema,
  agreementRecordAcceptanceInputSchema,
  agreementCloseInputSchema,
  readAgreementOfferSnapshot,
  agreementPublicDecisionSchema,
} from "@quits/contracts/agreements"
import { agreementScheduleConsequences } from "../agreements/consequences"
import { fingerprint } from "../approval-contexts"
import { defineCommand } from "../command"
import { Command, Db } from "../services"
import { Forbidden, InvalidState } from "../errors"
import {
  agreementInclude,
  lockedAgreement,
  requireLiveOffer,
  issuanceApproval,
  issueAgreementOffer,
} from "../agreements/issuance"
import { queueDocumentEmail, refuseWhileSending } from "../documents/document-delivery"
import { composeAgreementEmail } from "../documents/agreement-email"
import { resolveQuoteEmailContext, requireRecipientEmail } from "../documents/quote-email"
import { loadDocumentContext } from "../documents/context"
import { enqueueEmailDelivery } from "../delivery/outbox"
import {
  mintAgreementLink,
  verifyAgreementPublicToken,
  getAgreementPublicSecret,
} from "../../lib/agreements/tokens"

const humanOnly = Effect.gen(function* () {
  const { actor } = yield* Command
  if (actor.kind !== "user")
    return yield* new Forbidden({ message: "This action requires a person" })
})
const emailAvailable = (settings: Parameters<typeof resolveQuoteEmailContext>[0]) =>
  resolveQuoteEmailContext(settings).emailDelivery.available
    ? Effect.void
    : Effect.fail(
        new InvalidState({
          code: "email_unavailable",
          message: "Email delivery is not configured",
        }),
      )

export const sendAgreement = defineCommand({
  type: "agreement.send",
  permission: "agreement:send",
  outwardFacing: true,
  input: agreementIdInputSchema,
  summarize: ({ id }) => `Send agreement ${id}`,
  approvalContext: (input) => issuanceApproval(input, "email"),
  handle: (input) =>
    Effect.gen(function* () {
      const db = yield* Db
      const command = yield* Command
      const { agreement, settings } = yield* issueAgreementOffer(input, "email")
      yield* emailAvailable(settings)
      const { url } = mintAgreementLink(agreement, "decide", command.now)
      const recipient = agreement.issuedToEmail!
      const message = composeAgreementEmail({
        snapshot: readAgreementOfferSnapshot(agreement.offerSnapshot),
        number: agreement.number,
        locale: agreement.locale,
        settings,
        recipient,
        url,
      })
      const queued = yield* queueDocumentEmail({
        kind: "agreement",
        mode: "send",
        document: agreement,
        recipient,
        message,
        idempotencyKey: `agreement-send:${command.commandId}`,
        markSending: (data) =>
          db.agreement.update({ where: { id: agreement.id }, data, include: agreementInclude }),
      })
      return {
        ...queued.document,
        emailSent: false,
        emailPending: true,
        deliveryKey: queued.deliveryKey,
      }
    }),
})
export const issueAgreement = defineCommand({
  type: "agreement.issue",
  permission: "agreement:send",
  outwardFacing: true,
  input: agreementIssueInputSchema,
  summarize: ({ id }) => `Issue agreement ${id} without email`,
  approvalContext: (input) => issuanceApproval(input, "manual"),
  handle: (input) =>
    Effect.gen(function* () {
      return (yield* issueAgreementOffer(input, "manual")).agreement
    }),
})
const frozenApproval = (input: { id: string; recipient?: string }, action: "resend" | "read") =>
  Effect.gen(function* () {
    const { now } = yield* Command
    const agreement = yield* lockedAgreement(input.id)
    yield* refuseWhileSending("agreement", agreement)
    if (action === "resend") yield* requireLiveOffer(agreement, now)
    else if (
      !agreement.acceptedAt ||
      !["accepted", "completed", "cancelled"].includes(agreement.status)
    ) {
      return yield* new InvalidState({
        code: "not_accepted",
        message: "Read links require an accepted agreement",
      })
    }
    const recipient = yield* requireRecipientEmail({
      email: input.recipient ?? agreement.issuedToEmail,
    })
    const snapshot = readAgreementOfferSnapshot(agreement.offerSnapshot)
    return {
      summary: `${action === "resend" ? "Resend agreement" : "Send read link for"} ${agreement.number} to ${recipient ?? "no recipient"}`,
      version: `${agreement.offerSnapshotHash}:${recipient ?? ""}`,
      details: {
        number: agreement.number,
        recipient,
        total: snapshot.totalGross,
        currency: snapshot.currency,
      },
    }
  })
export const resendAgreement = defineCommand({
  type: "agreement.resend",
  permission: "agreement:send",
  outwardFacing: true,
  input: agreementResendInputSchema,
  summarize: ({ id }) => `Resend agreement ${id}`,
  approvalContext: (input) => frozenApproval(input, "resend"),
  handle: (input) =>
    Effect.gen(function* () {
      const db = yield* Db
      const command = yield* Command
      const agreement = yield* lockedAgreement(input.id)
      yield* refuseWhileSending("agreement", agreement)
      yield* requireLiveOffer(agreement, command.now)
      const recipient = yield* requireRecipientEmail({
        email: input.recipient ?? agreement.issuedToEmail,
      })
      const { settings } = yield* loadDocumentContext
      yield* emailAvailable(settings)
      const updated = yield* Effect.promise(() =>
        db.agreement.update({
          where: { id: agreement.id },
          data: {
            issuedToEmail: recipient,
            publicAccessKeyVersion: { increment: 1 },
            publicAccessIssuedAt: command.now,
          },
          include: agreementInclude,
        }),
      )
      if (recipient !== agreement.issuedToEmail)
        command.emit({
          aggregateType: "agreement",
          aggregateId: agreement.id,
          type: "agreement.recipient_changed",
          payload: {
            previousRecipient: agreement.issuedToEmail,
            recipient,
            offerRevision: agreement.offerRevision,
          },
        })
      const { url } = mintAgreementLink(updated, "decide", command.now)
      const message = composeAgreementEmail({
        snapshot: readAgreementOfferSnapshot(updated.offerSnapshot),
        number: updated.number,
        locale: updated.locale,
        settings,
        recipient,
        url,
      })
      const queued = yield* queueDocumentEmail({
        kind: "agreement",
        mode: "email",
        document: updated,
        recipient,
        message,
        idempotencyKey: `agreement-resend:${command.commandId}`,
        markSending: (data) =>
          db.agreement.update({ where: { id: agreement.id }, data, include: agreementInclude }),
      })
      return {
        ...queued.document,
        emailSent: false,
        emailPending: true,
        deliveryKey: queued.deliveryKey,
      }
    }),
})
export const recallAgreement = defineCommand({
  type: "agreement.recall",
  permission: "agreement:update",
  outwardFacing: false,
  input: agreementIdInputSchema,
  summarize: ({ id }) => `Recall agreement ${id}`,
  handle: (input) =>
    Effect.gen(function* () {
      yield* humanOnly
      const db = yield* Db
      const command = yield* Command
      const agreement = yield* lockedAgreement(input.id)
      yield* refuseWhileSending("agreement", agreement)
      if (!["sent", "expired", "declined"].includes(agreement.status))
        return yield* new InvalidState({
          code: "not_recallable",
          message: "Only sent, expired or declined offers can be recalled",
        })
      command.emit({
        aggregateType: "agreement",
        aggregateId: agreement.id,
        type: "agreement.offer_recalled",
        payload: {
          snapshot: agreement.offerSnapshot,
          hash: agreement.offerSnapshotHash,
          recipient: agreement.issuedToEmail,
          revision: agreement.offerRevision,
          keyVersion: agreement.publicAccessKeyVersion,
          decision: {
            acceptedAt: agreement.acceptedAt,
            acceptedOfferRevision: agreement.acceptedOfferRevision,
            acceptedByName: agreement.acceptedByName,
            acceptanceIp: agreement.acceptanceIp,
            acceptanceUserAgent: agreement.acceptanceUserAgent,
            acceptanceMethod: agreement.acceptanceMethod,
            acceptanceEvidenceNote: agreement.acceptanceEvidenceNote,
            declinedAt: agreement.declinedAt,
            declineReason: agreement.declineReason,
          },
        },
      })
      return yield* Effect.promise(() =>
        db.agreement.update({
          where: { id: agreement.id },
          data: {
            status: "draft",
            publicAccessKeyVersion: { increment: 1 },
            publicAccessIssuedAt: null,
            offerSnapshot: Prisma.DbNull,
            offerSnapshotHash: null,
            issuedToEmail: null,
            issuedVia: null,
            issueDate: null,
            expiresAt: null,
            acceptedAt: null,
            acceptedOfferRevision: null,
            acceptedByName: null,
            acceptanceIp: null,
            acceptanceUserAgent: null,
            acceptanceMethod: null,
            acceptanceEvidenceNote: null,
            declinedAt: null,
            declineReason: null,
          },
          include: agreementInclude,
        }),
      )
    }),
})
/** Notifications inherit the outbox's recovery, and never change agreement delivery markers. */
const notifyAccepted = (
  agreement: Awaited<ReturnType<typeof import("../agreements/queries").getAgreement>>,
  reviewedContext?: Effect.Effect.Success<typeof loadDocumentContext>,
) =>
  Effect.gen(function* () {
    const command = yield* Command
    const { settings } = reviewedContext ?? (yield* loadDocumentContext)
    const { url } = mintAgreementLink(agreement, "read", command.now)
    const snapshot = readAgreementOfferSnapshot(agreement.offerSnapshot)
    const recipients = acceptanceRecipients(settings.companyEmail, agreement.issuedToEmail)
    for (const recipient of recipients) {
      yield* enqueueEmailDelivery({
        message: composeAgreementEmail({
          snapshot,
          number: agreement.number,
          locale: agreement.locale,
          settings,
          recipient,
          url,
          accepted: true,
        }),
        idempotencyKey: `agreement-${agreement.id}-accepted-${recipient}`,
        completion: { kind: "agreement.notification", target: { agreementId: agreement.id } },
      })
    }
  })
export const recordAgreementAcceptance = defineCommand({
  type: "agreement.record_acceptance",
  permission: "agreement:accept",
  outwardFacing: false,
  input: agreementRecordAcceptanceInputSchema,
  summarize: ({ id }) => `Record acceptance of agreement ${id}`,
  approvalContext: (input) => Effect.gen(function* () {
    yield* humanOnly
    const { now } = yield* Command
    const agreement = yield* lockedAgreement(input.id)
    yield* refuseWhileSending("agreement", agreement)
    yield* requireLiveOffer(agreement, now)
    const { settings } = yield* loadDocumentContext
    const snapshot = readAgreementOfferSnapshot(agreement.offerSnapshot)
    const recipients = acceptanceRecipients(settings.companyEmail, agreement.issuedToEmail)
    const schedule = yield* agreementScheduleConsequences(agreement)
    return {
      summary: `Record acceptance of agreement ${agreement.number} by ${input.acceptedByName}`,
      version: fingerprint([agreement.offerSnapshotHash, agreement.offerRevision, agreement.status, recipients, schedule]),
      details: { number: agreement.number, recipient: agreement.issuedToEmail, total: snapshot.totalGross, currency: snapshot.currency, revision: agreement.offerRevision },
      preview: { snapshot, hash: agreement.offerSnapshotHash!, recipient: agreement.issuedToEmail },
      consequences: {
        records: [{ kind: "agreement_acceptance" as const, documentId: agreement.id, revision: String(agreement.offerRevision) }],
        messages: recipients.map(recipient => ({ kind: "agreement_accepted" as const, recipient })),
        manualSteps: ["invoice_eligible_work" as const, "prepayment_blocked" as const, "collect_payment" as const],
        refreshWhen: "agreement_offer" as const, schedule,
      },
    }
  }),
  handle: (input) =>
    Effect.gen(function* () {
      yield* humanOnly
      const db = yield* Db
      const command = yield* Command
      const agreement = yield* lockedAgreement(input.id)
      yield* refuseWhileSending("agreement", agreement)
      yield* requireLiveOffer(agreement, command.now)
      const accepted = yield* Effect.promise(() =>
        db.agreement.update({
          where: { id: agreement.id },
          data: {
            status: "accepted",
            acceptedAt: command.now,
            acceptedOfferRevision: agreement.offerRevision,
            acceptedByName: input.acceptedByName,
            acceptanceMethod: "internal",
            acceptanceEvidenceNote: input.evidenceNote,
            publicAccessKeyVersion: { increment: 1 },
            publicAccessIssuedAt: command.now,
          },
          include: agreementInclude,
        }),
      )
      command.emit({
        aggregateType: "agreement",
        aggregateId: agreement.id,
        type: "agreement.accepted",
        payload: {
          method: "internal",
          name: input.acceptedByName,
          evidenceNote: input.evidenceNote,
          revision: agreement.offerRevision,
          hash: agreement.offerSnapshotHash,
          recipient: agreement.issuedToEmail,
        },
      })
      yield* notifyAccepted(accepted)
      return accepted
    }),
})
export const closeAgreement = defineCommand({
  type: "agreement.close",
  permission: "agreement:close",
  outwardFacing: false,
  input: agreementCloseInputSchema,
  summarize: ({ id, disposition }) => `Close agreement ${id} as ${disposition}`,
  handle: (input) =>
    Effect.gen(function* () {
      yield* humanOnly
      const db = yield* Db
      const command = yield* Command
      const agreement = yield* lockedAgreement(input.id)
      yield* refuseWhileSending("agreement", agreement)
      if (input.disposition === "completed" ? agreement.status !== "accepted" : !["sent", "accepted"].includes(agreement.status))
        return yield* new InvalidState({ code: "not_closable", message: "Completion requires an accepted agreement; cancellation requires a sent or accepted agreement" })
      const reserved = agreement.deliverables.filter(line => line.billingStatus === "reserved")
      if (reserved.length) {
        const drafts = yield* Effect.promise(() => db.invoice.findMany({ where: { organizationId: command.organizationId, agreementId: agreement.id, status: "draft", items: { some: { deliverableId: { in: reserved.map(line => line.id) } } } }, select: { id: true, number: true }, orderBy: { id: "asc" } }))
        return yield* new InvalidState({ code: "reserved_deliverables", message: `Release the reservations on these linked drafts before closing: ${drafts.map(draft => `${draft.number} (${draft.id})`).join(", ")}` })
      }
      if (input.disposition === "completed") {
        const terminal = agreement.deliverables.map(line => input.cancelRemaining && line.billingStatus === "unbilled" && line.status !== "accepted" ? { ...line, status: "cancelled" } : line)
        if (terminal.some(line => (!line.isDeposit && !["accepted", "cancelled"].includes(line.status)) ||
          !(line.billingStatus === "invoiced" || (line.billingStatus === "unbilled" && line.status === "cancelled"))))
          return yield* new InvalidState({ code: "open_deliverables", message: "Completion requires terminal fulfillment and billing for every deliverable" })
        if (input.cancelRemaining) yield* Effect.promise(() => db.deliverable.updateMany({ where: { agreementId: agreement.id, billingStatus: "unbilled", status: { not: "accepted" } }, data: { status: "cancelled" } }))
      } else yield* Effect.promise(() => db.deliverable.updateMany({ where: { agreementId: agreement.id, billingStatus: { not: "invoiced" } }, data: { status: "cancelled" } }))
      const updated = yield* Effect.promise(() =>
        db.agreement.update({
          where: { id: agreement.id },
          data: {
            status: input.disposition,
            closedAt: command.now,
            closeReason: input.reason,
            ...(agreement.status === "sent"
              ? { publicAccessKeyVersion: { increment: 1 }, publicAccessIssuedAt: command.now }
              : {}),
          },
          include: agreementInclude,
        }),
      )
      command.emit({
        aggregateType: "agreement",
        aggregateId: agreement.id,
        type: input.disposition === "completed" ? "agreement.completed" : "agreement.cancelled",
        payload: { reason: input.reason, previousStatus: agreement.status },
      })
      return updated
    }),
})
export const revokeAgreementLinks = defineCommand({
  type: "agreement.revoke_links",
  permission: "agreement:update",
  outwardFacing: false,
  input: agreementIdInputSchema,
  summarize: ({ id }) => `Revoke links for agreement ${id}`,
  handle: (input) =>
    Effect.gen(function* () {
      yield* humanOnly
      const db = yield* Db
      const command = yield* Command
      const agreement = yield* lockedAgreement(input.id)
      yield* refuseWhileSending("agreement", agreement)
      if (!agreement.offerSnapshot)
        return yield* new InvalidState({
          code: "not_issued",
          message: "This agreement has no issued offer",
        })
      const updated = yield* Effect.promise(() =>
        db.agreement.update({
          where: { id: agreement.id },
          data: { publicAccessKeyVersion: { increment: 1 }, publicAccessIssuedAt: command.now },
          include: agreementInclude,
        }),
      )
      command.emit({
        aggregateType: "agreement",
        aggregateId: agreement.id,
        type: "agreement.links_revoked",
        payload: { keyVersion: updated.publicAccessKeyVersion },
      })
      return updated
    }),
})
export const sendAgreementReadLink = defineCommand({
  type: "agreement.send_read_link",
  permission: "agreement:send",
  outwardFacing: true,
  input: agreementIdInputSchema,
  summarize: ({ id }) => `Send read link for agreement ${id}`,
  approvalContext: (input) => frozenApproval(input, "read"),
  handle: (input) =>
    Effect.gen(function* () {
      const command = yield* Command
      const agreement = yield* lockedAgreement(input.id)
      yield* refuseWhileSending("agreement", agreement)
      if (
        !agreement.acceptedAt ||
        !["accepted", "completed", "cancelled"].includes(agreement.status)
      )
        return yield* new InvalidState({
          code: "not_accepted",
          message: "Read links require an accepted agreement",
        })
      const recipient = yield* requireRecipientEmail({ email: agreement.issuedToEmail })
      const { settings } = yield* loadDocumentContext
      yield* emailAvailable(settings)
      const { url } = mintAgreementLink(agreement, "read", command.now)
      const queued = yield* enqueueEmailDelivery({
        message: composeAgreementEmail({
          snapshot: readAgreementOfferSnapshot(agreement.offerSnapshot),
          number: agreement.number,
          locale: agreement.locale,
          settings,
          recipient,
          url,
          accepted: true,
        }),
        idempotencyKey: `agreement-read:${command.commandId}`,
        completion: { kind: "agreement.notification", target: { agreementId: agreement.id } },
      })
      command.emit({
        aggregateType: "agreement",
        aggregateId: agreement.id,
        type: "agreement.read_link_sent",
        payload: { recipient, url },
      })
      return { ...agreement, deliveryKey: queued.deliveryKey }
    }),
})

/** Only the verified public-link dispatcher calls this. It is absent from both registries. */
export const recordAgreementCustomerDecision = defineCommand({
  type: "agreement.customer_decision",
  permission: "agreement:accept",
  outwardFacing: false,
  input: z
    .object({
      token: z.string().min(1).max(4096),
      decision: agreementPublicDecisionSchema,
      ip: z.string().max(200).nullable().optional(),
      userAgent: z.string().max(1000).nullable().optional(),
    })
    .strict(),
  summarize: () => "Record customer agreement decision",
  handle: (input) =>
    Effect.gen(function* () {
      const db = yield* Db
      const command = yield* Command
      if (command.actor.kind !== "system" || command.actor.reason !== "customer_link")
        return yield* new Forbidden({ message: "Customer decisions require a public link" })
      const payload = verifyAgreementPublicToken(input.token, getAgreementPublicSecret())
      if (!payload || payload.scope !== "decide")
        return yield* new InvalidState({ code: "invalid", message: "This link is no longer valid" })
      const identity = yield* Effect.promise(() =>
        db.agreement.findFirst({
          where: { id: payload.agreementId, organizationId: command.organizationId },
          select: { publicAccessKeyVersion: true, offerRevision: true },
        }),
      )
      if (
        !identity ||
        identity.publicAccessKeyVersion !== payload.keyVersion ||
        identity.offerRevision !== payload.offerRevision
      )
        return yield* new InvalidState({ code: "invalid", message: "This link is no longer valid" })
      const agreement = yield* lockedAgreement(payload.agreementId)
      if (
        agreement.publicAccessKeyVersion !== payload.keyVersion ||
        agreement.offerRevision !== payload.offerRevision
      )
        return yield* new InvalidState({ code: "invalid", message: "This link is no longer valid" })
      const accepted =
        agreement.acceptedOfferRevision === payload.offerRevision && agreement.acceptedAt !== null
      const declined =
        agreement.offerRevision === payload.offerRevision && agreement.declinedAt !== null
      if (accepted || declined) {
        if (
          (accepted && input.decision.decision === "accept") ||
          (declined && input.decision.decision === "decline")
        )
          return agreement
        return yield* new InvalidState({
          code: "already_decided",
          message: "This offer already has a decision",
        })
      }
      if (agreement.lastEmailAttemptOutcome === "sending")
        return yield* new InvalidState({
          code: "retry_later",
          message: "This agreement is being emailed. Please try again later.",
        })
      yield* requireLiveOffer(agreement, command.now)
      if (command.now >= new Date(payload.exp))
        return yield* new InvalidState({ code: "invalid", message: "This link is no longer valid" })
      const decision = input.decision
      const reviewedContext = decision.decision === "accept" ? yield* loadDocumentContext : undefined
      if (decision.decision === "accept" && decision.expectedPreviewVersion !==
        publicAcceptancePreview(agreement, reviewedContext!.settings.companyEmail).version) {
        // Missing versions include old pages/clients. The original link can still reload
        // the current review, but never bypass the recipient check on a new acceptance.
        return yield* new InvalidState({ code: "changed_since_review", message: "The acceptance review changed. Reload and review the recipients before accepting." })
      }
      const updated = yield* Effect.promise(() =>
        db.agreement.update({
          where: { id: agreement.id },
          data:
            decision.decision === "accept"
              ? {
                  status: "accepted",
                  acceptedAt: command.now,
                  acceptedOfferRevision: payload.offerRevision,
                  acceptedByName: decision.acceptedByName,
                  acceptanceIp: input.ip ?? null,
                  acceptanceUserAgent: input.userAgent ?? null,
                  acceptanceMethod: "customer_link",
                }
              : {
                  status: "declined",
                  declinedAt: command.now,
                  declineReason: decision.reason ?? null,
                },
          include: agreementInclude,
        }),
      )
      command.emit({
        aggregateType: "agreement",
        aggregateId: agreement.id,
        type: decision.decision === "accept" ? "agreement.accepted" : "agreement.declined",
        payload: {
          revision: payload.offerRevision,
          hash: agreement.offerSnapshotHash,
          recipient: agreement.issuedToEmail,
          method: "customer_link",
          ...(decision.decision === "accept"
            ? { name: decision.acceptedByName }
            : { reason: decision.reason ?? null }),
        },
      })
      if (decision.decision === "accept") yield* notifyAccepted(updated, reviewedContext)
      return updated
    }),
})

export const agreementLifecycleCommands = [
  sendAgreement,
  issueAgreement,
  resendAgreement,
  recallAgreement,
  recordAgreementAcceptance,
  closeAgreement,
  revokeAgreementLinks,
  sendAgreementReadLink,
] as const
