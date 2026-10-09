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

/** Bulk reads share the caller's organization lock and retain every receipt event. */
export async function receiptProvenanceForReceipts(
  db: Prisma.TransactionClient,
  organizationId: string,
  receipts: SettlementReceipt[],
) {
  const receiptIds = receipts.map((receipt) => receipt.id)
  const [verifications, returns, events] = await Promise.all([
    db.settlementEvidenceDecision.findMany({
      where: {
        receiptId: { in: receiptIds },
        action: { in: ["match", "confirm"] },
        source: {
          organizationId,
          receiptId: { in: receiptIds },
          observations: { none: { state: "returned" } },
        },
      },
      orderBy: [{ createdAt: "desc" }, { revision: "desc" }],
      select: { receiptId: true, actorKey: true, createdAt: true, source: { select: { receiptId: true } } },
    }),
    db.settlementEvidenceDecision.findMany({
      where: { receiptId: { in: receiptIds }, action: "return", source: { organizationId } },
      select: { receiptId: true },
    }),
    db.domainEvent.findMany({
      where: {
        organizationId,
        type: { startsWith: "settlement." },
        // Prisma JSON filters cannot express membership at a path with `in`.
        OR: receiptIds.map((id) => ({ payload: { path: ["receiptId"], equals: id } })),
      },
      orderBy: { sequence: "asc" },
      select: {
        id: true, type: true, actorKind: true, actorId: true,
        occurredAt: true, commandId: true, payload: true,
      },
    }),
  ])
  const verificationByReceipt = new Map<string, (typeof verifications)[number]>()
  for (const decision of verifications) {
    // A source may have moved to another selected receipt. Its old decision is history only.
    if (decision.source.receiptId === decision.receiptId && !verificationByReceipt.has(decision.receiptId)) {
      verificationByReceipt.set(decision.receiptId, decision)
    }
  }
  const returnedIds = new Set(returns.map((decision) => decision.receiptId))
  const eventsByReceipt = new Map<string, typeof events>()
  for (const event of events) {
    const payload = event.payload
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) continue
    const id = payload.receiptId
    if (typeof id !== "string") continue
    const history = eventsByReceipt.get(id) ?? []
    history.push(event)
    eventsByReceipt.set(id, history)
  }
  return new Map(receipts.map((receipt) => {
    const verified = !receipt.reversedAt ? verificationByReceipt.get(receipt.id) : null
    return [receipt.id, {
      provenance: receiptProvenanceSchema.parse({
        state: returnedIds.has(receipt.id) ? "returned" : verified ? "verified" : "received",
        recordedBy: receipt.actorKey,
        recordedAt: receipt.createdAt.toISOString(),
        verifiedBy: verified?.actorKey ?? null,
        verifiedAt: verified?.createdAt.toISOString() ?? null,
      }),
      history: eventsByReceipt.get(receipt.id) ?? [],
    }]
  }))
}
