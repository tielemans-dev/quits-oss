import { z } from "zod"
import { paymentMethodSchema, settlementAmountSchema, settlementEvidenceSchema } from "./payments"

const id = z.string().trim().min(1).max(200)
const request = { requestId: id }
export const settlementEvidenceSourceSchema = z.enum(["client", "bank", "provider"])
export const settlementEvidenceStateSchema = z.enum([
  "reported",
  "processing",
  "received",
  "returned",
])
export const settlementProvenanceStateSchema = z.enum([
  "reported",
  "processing",
  "received",
  "verified",
  "returned",
])

/** Operator-entered source facts. Recording an observation never changes cash or invoice debt. */
export const settlementEvidenceInputSchema = z
  .object({
    ...request,
    contactId: id,
    source: settlementEvidenceSourceSchema,
    /** Stable non-secret provider/account or bank-account identifier, not an import batch ID. */
    accountReference: id,
    transactionReference: id,
    /** Stable source event or statement row ID. Reimports must retain this ID. */
    eventReference: id,
    state: settlementEvidenceStateSchema,
    occurredAt: z.iso.datetime(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    netAmount: settlementAmountSchema,
    feeAmount: settlementAmountSchema.default("0"),
    feeEvidence: settlementEvidenceSchema.optional(),
    ...settlementEvidenceSchema.shape,
    /** A correction preserves the old observation and explicitly replaces it. */
    correctsEvidenceId: id.optional(),
    /** A return names the received evidence for this transaction. */
    reversesEvidenceId: id.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.source === "client" && value.state !== "reported")
      ctx.addIssue({
        code: "custom",
        path: ["state"],
        message: "A customer assertion can only be reported",
      })
    if ((value.state === "returned") !== Boolean(value.reversesEvidenceId))
      ctx.addIssue({
        code: "custom",
        path: ["reversesEvidenceId"],
        message: "A return must name the original received evidence",
      })
    if (value.correctsEvidenceId && value.state !== "received")
      ctx.addIssue({
        code: "custom",
        path: ["correctsEvidenceId"],
        message: "Only received evidence can be corrected",
      })
  })

export const settlementIdentitySchema = z
  .object({
    kind: z.enum(["transaction_reference", "provider_payment_id", "remittance_document"]),
    value: id,
    ...settlementEvidenceSchema.shape,
  })
  .strict()
const decision = { ...request, evidenceId: id, ...settlementEvidenceSchema.shape }
export const settlementEvidenceDecisionSchema = z.discriminatedUnion("action", [
  z
    .object({
      ...decision,
      action: z.literal("match"),
      receiptId: id,
      identity: settlementIdentitySchema,
    })
    .strict(),
  z
    .object({
      ...decision,
      action: z.literal("confirm"),
      method: paymentMethodSchema,
      identity: settlementIdentitySchema,
    })
    .strict(),
  z.object({ ...decision, action: z.literal("unmatch"), receiptId: id }).strict(),
  /** Withdraw a mistaken match after unmatching. Never withdraw source-created cash. */
  z.object({ ...decision, action: z.literal("reject_match"), receiptId: id }).strict(),
  z
    .object({
      ...decision,
      action: z.literal("return"),
      receiptId: id,
      identity: settlementIdentitySchema.optional(),
    })
    .strict(),
])
export const settlementEvidenceCommitSchema = z
  .object({
    decision: settlementEvidenceDecisionSchema,
    previewToken: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
export const settlementProvenanceListSchema = z.object({ contactId: id }).strict()
export type SettlementEvidenceInput = z.infer<typeof settlementEvidenceInputSchema>
export type SettlementEvidenceDecision = z.infer<typeof settlementEvidenceDecisionSchema>

const attribution = { actorKey: z.string(), commandId: z.string(), recordedAt: z.iso.datetime() }
export const receiptProvenanceSchema = z
  .object({
    state: z.enum(["received", "verified", "returned"]),
    recordedBy: z.string(),
    recordedAt: z.iso.datetime(),
    verifiedBy: z.string().nullable(),
    verifiedAt: z.iso.datetime().nullable(),
  })
  .strict()
export const settlementProvenanceHistorySchema = z
  .object({
    id: id,
    source: settlementEvidenceSourceSchema,
    accountReference: id,
    transactionReference: id,
    receiptId: id.nullable(),
    createdReceiptId: id.nullable(),
    revision: z.number().int(),
    state: settlementProvenanceStateSchema,
    /** An informational review deadline only. No automated collection hold is granted. */
    processingReviewUntil: z.iso.datetime().nullable(),
    automaticCollectionSuppression: z.literal(false),
    returnPending: z.boolean(),
    observations: z.array(
      z
        .object({
          id,
          eventReference: id,
          state: settlementEvidenceStateSchema,
          occurredAt: z.iso.datetime(),
          currency: z.string(),
          netAmount: settlementAmountSchema,
          feeAmount: settlementAmountSchema,
          reason: z.string(),
          evidence: z.string(),
          feeReason: z.string().nullable(),
          feeEvidence: z.string().nullable(),
          correctsEvidenceId: id.nullable(),
          reversesEvidenceId: id.nullable(),
          ...attribution,
        })
        .strict(),
    ),
    decisions: z.array(
      z
        .object({
          id,
          action: z.enum(["match", "confirm", "unmatch", "reject_match", "return"]),
          evidenceId: id,
          receiptId: id,
          reason: z.string(),
          evidence: z.string(),
          identity: settlementIdentitySchema.nullable(),
          ...attribution,
        })
        .strict(),
    ),
  })
  .strict()
