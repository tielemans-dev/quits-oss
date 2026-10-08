import {
  receiptProvenanceSchema,
  settlementProvenanceHistorySchema,
} from "@quits/contracts/settlement-provenance"
import type { Prisma, SettlementReceipt } from "../../../generated/prisma/client"

export const PROCESSING_REVIEW_WINDOW_MS = 72 * 60 * 60 * 1000

/** Display guidance only. Neither assertions nor processing observations suspend collections. */
export async function settlementProvenanceHistory(
  db: Prisma.TransactionClient,
  organizationId: string,
  contactId: string,
  now = new Date(),
) {
  const sources = await db.settlementEvidenceSource.findMany({
    where: { organizationId, contactId },
    orderBy: { id: "asc" },
    include: {
      receipt: true,
      observations: { orderBy: { revision: "asc" } },
      decisions: { orderBy: { revision: "asc" } },
    },
  })
  return sources.map((source) => {
    const received = source.observations.some((row) => row.state === "received")
    const returned = source.observations.some((row) => row.state === "returned")
    const processing = source.observations.filter((row) => row.state === "processing")
    const deadline = processing.length
      ? new Date(
          Math.min(...processing.map((row) => row.occurredAt.getTime())) +
            PROCESSING_REVIEW_WINDOW_MS,
        )
      : null
    const state = returned
      ? "returned"
      : source.receipt && !source.receipt.reversedAt
        ? "verified"
        : received
          ? "received"
          : processing.length
            ? "processing"
            : "reported"
    return settlementProvenanceHistorySchema.parse({
      id: source.id,
      source: source.source,
      accountReference: source.accountReference,
      transactionReference: source.transactionReference,
      receiptId: source.receiptId,
      createdReceiptId: source.createdReceiptId,
      revision: source.revision,
      state,
      processingReviewUntil:
        state === "processing" && deadline && deadline > now ? deadline.toISOString() : null,
      automaticCollectionSuppression: false,
      returnPending: returned && Boolean(source.receipt && !source.receipt.reversedAt),
      observations: source.observations.map((row) => ({
        id: row.id,
        eventReference: row.eventReference,
        state: row.state,
        occurredAt: row.occurredAt.toISOString(),
        currency: row.currency,
        netAmount: row.netAmount.toFixed(2),
        feeAmount: row.feeAmount.toFixed(2),
        feeReason: row.feeReason,
        feeEvidence: row.feeEvidence,
        reason: row.reason,
        evidence: row.evidence,
        correctsEvidenceId: row.correctsEvidenceId,
        reversesEvidenceId: row.reversesEvidenceId,
        actorKey: row.actorKey,
        commandId: row.commandId,
        recordedAt: row.createdAt.toISOString(),
      })),
      decisions: source.decisions.map((row) => ({
        id: row.id,
        action: row.action,
        evidenceId: row.evidenceId,
        receiptId: row.receiptId,
        reason: row.reason,
        evidence: row.evidence,
        identity: row.identity,
        actorKey: row.actorKey,
        commandId: row.commandId,
        recordedAt: row.createdAt.toISOString(),
      })),
    })
  })
}

export async function receiptProvenance(db: Prisma.TransactionClient, receipt: SettlementReceipt) {
  const [verification, returned] = await Promise.all([
    db.settlementEvidenceDecision.findFirst({
      where: {
        receiptId: receipt.id,
        action: { in: ["match", "confirm"] },
        source: { receiptId: receipt.id, observations: { none: { state: "returned" } } },
      },
      orderBy: [{ createdAt: "desc" }, { revision: "desc" }],
    }),
    db.settlementEvidenceDecision.findFirst({ where: { receiptId: receipt.id, action: "return" } }),
  ])
  const verified = !receipt.reversedAt ? verification : null
  return receiptProvenanceSchema.parse({
    state: returned ? "returned" : verified ? "verified" : "received",
    recordedBy: receipt.actorKey,
    recordedAt: receipt.createdAt.toISOString(),
    verifiedBy: verified?.actorKey ?? null,
    verifiedAt: verified?.createdAt.toISOString() ?? null,
  })
}
