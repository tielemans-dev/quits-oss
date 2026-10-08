import { readAgreementOfferSnapshot, type AgreementOfferSnapshot } from "@quits/contracts/agreements"
import type { Agreement, Deliverable } from "../../../generated/prisma/client"
import { sanitizeAgreementHtml } from "./markdown"

/** Public evidence excludes IP, user agent and internal evidence notes. */
export function agreementAcceptanceRecord(agreement: Agreement) {
  if (!agreement.acceptedAt) return null
  return {
    name: agreement.acceptedByName,
    intendedRecipient: agreement.issuedToEmail,
    at: agreement.acceptedAt.toISOString(),
    method: agreement.acceptanceMethod,
    revision: agreement.acceptedOfferRevision,
    hash: agreement.offerSnapshotHash,
  }
}
/** Explicit allowlist. Never spread the database row into a public response. */
export function publicAgreementDto(
  agreement: Agreement & {
    deliverables?: Pick<Deliverable, "sortOrder" | "expectedDate">[]
  },
) {
  const snapshot = readAgreementOfferSnapshot(agreement.offerSnapshot)
  return {
    number: agreement.number,
    status: agreement.status,
    offerRevision: agreement.offerRevision,
    issueDate: agreement.issueDate?.toISOString() ?? null,
    expiresAt: agreement.expiresAt?.toISOString() ?? null,
    snapshot: {
      ...snapshot,
      termsHtml: sanitizeAgreementHtml(snapshot.termsHtml),
    } as AgreementOfferSnapshot,
    expectedDates: snapshot.deliverables.map(
      (line) =>
        agreement.deliverables
          ?.find((current) => current.sortOrder === line.sortOrder)
          ?.expectedDate?.toISOString() ?? null,
    ),
    acceptance: agreementAcceptanceRecord(agreement),
    declinedAt: agreement.declinedAt?.toISOString() ?? null,
    declineReason: agreement.declineReason,
  }
}
export type PublicAgreementDto = ReturnType<typeof publicAgreementDto>

/** One delivery only; no billing links, internal evidence, IP or agent notes. */
export function publicDeliverableDto(agreement: Agreement, line: Deliverable) {
  return {
    agreementNumber: agreement.number,
    agreementTitle: agreement.title,
    title: line.title,
    description: line.description,
    status: line.status,
    deliveryRevision: line.deliveryRevision,
    deliveredAt: line.deliveredAt?.toISOString() ?? null,
    acceptedAt: line.acceptedAt?.toISOString() ?? null,
    acceptedRevision: line.acceptedRevision,
    changeRequestNote: line.changeRequestNote,
    agreedDate: line.agreedDate?.toISOString() ?? null,
    expectedDate: line.expectedDate?.toISOString() ?? null,
  }
}
export type PublicDeliverableDto = ReturnType<typeof publicDeliverableDto>
