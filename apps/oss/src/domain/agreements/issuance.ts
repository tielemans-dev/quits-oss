import { Effect } from "effect"
import { buildBuyerSnapshot, buildSellerSnapshot, buyerContactSelect } from "../documents/snapshots"
import { lockDocument } from "../documents/locks"
import { loadDocumentContext } from "../documents/context"
import { allocateDocumentNumber } from "../documents/numbering"
import { refuseWhileSending } from "../documents/document-delivery"
import { InvalidState, NotFound } from "../errors"
import { Command, Db } from "../services"
import { agreementExpiresAt } from "./expiry"
import { buildOfferSnapshot, hashOfferSnapshot } from "./snapshot"
import { requireRecipientEmail } from "../documents/invoice-email"

export const agreementInclude = {
  contact: true,
  deliverables: { orderBy: { sortOrder: "asc" as const } },
}
export const lockedAgreement = (id: string) =>
  Effect.gen(function* () {
    const db = yield* Db
    const { organizationId } = yield* Command
    yield* lockDocument("agreement", id, { strength: "update" })
    const agreement = yield* Effect.promise(() =>
      db.agreement.findFirst({ where: { id, organizationId }, include: agreementInclude }),
    )
    if (!agreement)
      return yield* new NotFound({ message: "Agreement not found", entity: "agreement", id })
    return agreement
  })
export const requireLiveOffer = (
  agreement: { status: string; expiresAt: Date | null },
  now: Date,
) =>
  Effect.gen(function* () {
    if (agreement.status !== "sent")
      return yield* new InvalidState({
        code: "not_sent",
        message: "Only sent agreements allow this action",
      })
    if (!agreement.expiresAt || now >= agreement.expiresAt)
      return yield* new InvalidState({
        code: "expired",
        message: "The agreement offer has expired",
      })
  })
export const prospectiveIssuance = (
  input: { id: string; recipient?: string },
  method: "email" | "manual",
) =>
  Effect.gen(function* () {
    const db = yield* Db
    const { now, organizationId } = yield* Command
    const draft = yield* lockedAgreement(input.id)
    yield* lockDocument("contact", draft.contactId, { strength: "no_key_update" })
    yield* refuseWhileSending("agreement", draft)
    if (draft.status !== "draft")
      return yield* new InvalidState({
        code: "not_draft",
        message: "Only draft agreements can be issued",
      })
    if (!draft.deliverables.some((line) => line.status !== "cancelled"))
      return yield* new InvalidState({
        code: "no_deliverables",
        message: "At least one non-cancelled deliverable is required",
      })
    const expiresAt = agreementExpiresAt(draft.validUntil, draft.timezone)
    if (now >= expiresAt)
      return yield* new InvalidState({
        code: "expired",
        message: "The agreement validity has ended",
      })
    const contact = yield* Effect.promise(() =>
      db.contact.findFirstOrThrow({
        where: { id: draft.contactId, organizationId },
        select: buyerContactSelect,
      }),
    )
    const { settings, sellerTaxIds } = yield* loadDocumentContext
    const sellerSnapshot = buildSellerSnapshot(settings, sellerTaxIds)
    const buyerSnapshot = buildBuyerSnapshot(contact)
    const snapshot = buildOfferSnapshot({ ...draft, sellerSnapshot, buyerSnapshot })
    const hash = hashOfferSnapshot(snapshot)
    const recipient =
      method === "email" ? yield* requireRecipientEmail(contact) : (input.recipient ?? null)
    return { draft, snapshot, hash, recipient, expiresAt, sellerSnapshot, buyerSnapshot, settings }
  })
export const issuanceApproval = (
  input: { id: string; recipient?: string },
  method: "email" | "manual",
) =>
  Effect.gen(function* () {
    const { draft, snapshot, hash, recipient } = yield* prospectiveIssuance(input, method)
    return {
      summary: `${method === "email" ? "Send" : "Issue"} agreement ${draft.title} (${snapshot.totalGross} ${snapshot.currency}) to ${recipient ?? "be shared manually"}`,
      version: `${hash}:${recipient ?? ""}`,
      details: {
        title: snapshot.title,
        total: snapshot.totalGross,
        currency: snapshot.currency,
        recipient,
        validUntil: snapshot.validUntil.slice(0, 10),
      },
      preview: { snapshot, hash, recipient },
    }
  })
/** Called after the approval version check, under the same transaction and locks. */
export const issueAgreementOffer = (
  input: { id: string; recipient?: string },
  method: "email" | "manual",
) =>
  Effect.gen(function* () {
    const db = yield* Db
    const command = yield* Command
    const prospective = yield* prospectiveIssuance(input, method)
    const { draft, hash, recipient, snapshot, expiresAt, sellerSnapshot, buyerSnapshot } =
      prospective
    if (
      command.expectedApprovalVersion &&
      command.expectedApprovalVersion !== `${hash}:${recipient ?? ""}`
    )
      return yield* new InvalidState({
        code: "changed_since_review",
        message: "The document changed after approval review",
      })
    const unchanged = draft.offerSnapshotHash === hash && draft.issuedToEmail === recipient
    const number = command.issuance?.number ?? draft.number ?? (yield* allocateDocumentNumber("agreement"))
    const agreement = yield* Effect.promise(() =>
      db.agreement.update({
        where: { id: draft.id },
        data: {
          sellerSnapshot,
          buyerSnapshot,
          number,
          issuedVia: method,
          ...(unchanged
            ? {}
            : {
                offerSnapshot: snapshot,
                offerSnapshotHash: hash,
                offerRevision: { increment: 1 },
                issuedToEmail: recipient,
                issueDate: command.issuance?.issuedAt ?? command.now,
                expiresAt,
                publicAccessKeyVersion: { increment: 1 },
                publicAccessIssuedAt: command.now,
              }),
          ...(method === "manual" ? { status: "sent" } : {}),
        },
        include: agreementInclude,
      }),
    )
    command.emit({
      aggregateType: "agreement",
      aggregateId: agreement.id,
      type: "agreement.offer_issued",
      payload: {
        number,
        offerRevision: agreement.offerRevision,
        hash,
        recipient,
        method,
        unchangedRetry: unchanged,
      },
    })
    if (method === "manual")
      command.emit({
        aggregateType: "agreement",
        aggregateId: agreement.id,
        type: "agreement.sent",
        payload: { number, recipient, emailSent: false },
      })
    return { agreement, settings: prospective.settings }
  })
