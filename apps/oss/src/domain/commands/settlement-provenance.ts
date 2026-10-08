import { createHash } from "node:crypto"
import { Effect } from "effect"
import {
  settlementEvidenceInputSchema,
  settlementEvidenceCommitSchema,
  type SettlementEvidenceDecision,
} from "@quits/contracts/settlement-provenance"
import { Prisma, type SettlementEvidence } from "../../../generated/prisma/client"
import { actorKey } from "../actor"
import { defineCommand } from "../command"
import { computeSettlement } from "../documents/settlement"
import { Forbidden, InvalidState } from "../errors"
import { parseOrganizationRoles, roleHasPermission, type Permission } from "../permissions"
import { Command, Db } from "../services"
import {
  SettlementRefusal,
  recordReceipt,
  changeReceipt,
  previewReceiptChange,
  receiptBalance,
  settlementAmount,
} from "./settlements"

export class ProvenanceRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}
const refuse = (code: string, message: string): never => {
  throw new ProvenanceRefusal(code, message)
}
const run = <T>(f: () => Promise<T>) =>
  Effect.tryPromise({
    try: f,
    catch: (error) => {
      if (error instanceof ProvenanceRefusal || error instanceof SettlementRefusal)
        return new InvalidState({ code: error.code, message: error.message })
      throw error
    },
  })
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const personOnly = () =>
  Effect.fail(new Forbidden({ message: "Provenance decisions require a person" }))

/** Recheck membership inside the command transaction, including callers with a stale actor. */
const authorize = (permission: Permission) =>
  Effect.gen(function* () {
    const db = yield* Db
    const command = yield* Command
    if (command.actor.kind !== "user") return yield* personOnly()
    const userId = command.actor.userId
    // Hold membership while the decision commits, so revocation cannot race the write.
    yield* Effect.promise(
      () =>
        db.$queryRaw`SELECT id FROM member WHERE "organizationId" = ${command.organizationId} AND "userId" = ${userId} FOR SHARE`,
    )
    const membership = yield* Effect.promise(() =>
      db.member.findUnique({
        where: {
          organizationId_userId: { organizationId: command.organizationId, userId },
        },
      }),
    )
    if (!membership || !roleHasPermission(parseOrganizationRoles(membership.role), permission))
      return yield* new Forbidden({
        message: `Current membership must allow ${permission}`,
        permission,
      })
  })

const includeHistory = {
  observations: { orderBy: { revision: "asc" as const } },
  decisions: { orderBy: { revision: "asc" as const } },
}
export async function loadEvidenceSource(
  db: Prisma.TransactionClient,
  organizationId: string,
  evidenceId: string,
) {
  const observation = await db.settlementEvidence.findFirst({
    where: { id: evidenceId, source: { organizationId } },
  })
  if (!observation) return refuse("evidence_not_found", "Evidence not found")
  const source = await db.settlementEvidenceSource.findUniqueOrThrow({
    where: { id: observation.sourceId },
    include: includeHistory,
  })
  return { observation, source }
}
function activeReceived(observations: SettlementEvidence[]) {
  const correctionRevision = Math.max(
    0,
    ...observations.filter((row) => row.correctsEvidenceId).map((row) => row.revision),
  )
  return observations.filter(
    (row) => row.state === "received" && row.revision >= correctionRevision,
  )
}
function sameAmounts(a: SettlementEvidence, b: SettlementEvidence) {
  return (
    a.currency === b.currency && a.netAmount.equals(b.netAmount) && a.feeAmount.equals(b.feeAmount)
  )
}

export const recordSettlementEvidence = defineCommand({
  type: "settlement.record_evidence",
  permission: "payment:create",
  outwardFacing: true,
  requiresApproval: personOnly,
  input: settlementEvidenceInputSchema,
  summarize: (input) => `Record ${input.state} evidence ${input.eventReference}`,
  handle: (input) =>
    Effect.gen(function* () {
      yield* authorize(input.correctsEvidenceId ? "payment:void" : "payment:create")
      const db = yield* Db
      const command = yield* Command
      const result = yield* run(async () => {
        if (new Date(input.occurredAt) > command.now)
          return refuse("future_evidence", "Evidence cannot occur in the future")
        // Reuse the money draft's exact supported currency and minor-unit checks.
        const netAmount = settlementAmount(input.netAmount, input.currency, true)
        const feeAmount = settlementAmount(input.feeAmount, input.currency, true)
        settlementAmount(netAmount.plus(feeAmount).toFixed(2), input.currency)
        if (feeAmount.greaterThan(0) && !input.feeEvidence)
          return refuse("fee_evidence_required", "Fee evidence is required")
        const contact = await db.contact.findFirst({
          where: { id: input.contactId, organizationId: command.organizationId },
        })
        if (!contact) return refuse("contact_not_found", "Customer not found")
        const { requestId: _requestId, ...facts } = input
        const payloadHash = hash({
          ...facts,
          netAmount: netAmount.toFixed(2),
          feeAmount: feeAmount.toFixed(2),
        })
        let source = await db.settlementEvidenceSource.findUnique({
          where: {
            organizationId_source_accountReference_transactionReference: {
              organizationId: command.organizationId,
              source: input.source,
              accountReference: input.accountReference,
              transactionReference: input.transactionReference,
            },
          },
          include: includeHistory,
        })
        // Event identity is account-scoped, so moving a repeated event to a new transaction is refused.
        const duplicate = await db.settlementEvidence.findFirst({
          where: {
            eventReference: input.eventReference,
            source: {
              organizationId: command.organizationId,
              source: input.source,
              accountReference: input.accountReference,
            },
          },
        })
        if (duplicate) {
          if (duplicate.payloadHash !== payloadHash)
            return refuse(
              "evidence_event_conflict",
              "The source event already exists with different facts. Record an explicit correction.",
            )
          return { evidenceId: duplicate.id, sourceId: duplicate.sourceId, duplicate: true }
        }
        if (source && source.contactId !== input.contactId)
          return refuse("customer_mismatch", "A transaction cannot change customer")
        if (!source) {
          if (input.correctsEvidenceId || input.reversesEvidenceId)
            return refuse(
              "evidence_not_found",
              "Original evidence must belong to this source transaction",
            )
          source = await db.settlementEvidenceSource.create({
            data: {
              organizationId: command.organizationId,
              contactId: input.contactId,
              source: input.source,
              accountReference: input.accountReference,
              transactionReference: input.transactionReference,
            },
            include: includeHistory,
          })
        }
        const received = activeReceived(source.observations)
        if (input.correctsEvidenceId) {
          if (source.receiptId)
            return refuse("evidence_in_use", "Unmatch evidence before correcting it")
          if (source.createdReceiptId) {
            const createdReceipt = await db.settlementReceipt.findUniqueOrThrow({
              where: { id: source.createdReceiptId },
            })
            if (!createdReceipt.reversedAt)
              return refuse(
                "evidence_in_use",
                "Reverse the source-created receipt through the money correction workflow before correcting its evidence",
              )
          }
          if (source.observations.some((row) => row.state === "returned"))
            return refuse("evidence_returned", "Returned source evidence cannot be replaced")
          if (received.at(-1)?.id !== input.correctsEvidenceId)
            return refuse("correction_changed", "Correct the current received observation")
        } else if (
          input.state === "received" &&
          received.some(
            (row) =>
              row.currency !== input.currency ||
              !row.netAmount.equals(netAmount) ||
              !row.feeAmount.equals(feeAmount),
          )
        ) {
          return refuse(
            "evidence_amount_conflict",
            "Changed source amounts require an explicit correction",
          )
        }
        if (input.state === "returned") {
          const original = received.find((row) => row.id === input.reversesEvidenceId)
          if (!original)
            return refuse(
              "return_reference_invalid",
              "A return must reference current received evidence from this transaction",
            )
          if (
            original.currency !== input.currency ||
            !original.netAmount.equals(netAmount) ||
            !original.feeAmount.equals(feeAmount)
          )
            return refuse(
              "return_amount_mismatch",
              "This workflow requires a full return of the original net and fee quantities",
            )
        }
        const observation = await db.settlementEvidence.create({
          data: {
            sourceId: source.id,
            revision: source.revision + 1,
            eventReference: input.eventReference,
            state: input.state,
            occurredAt: new Date(input.occurredAt),
            currency: input.currency,
            netAmount,
            feeAmount,
            feeReason: input.feeEvidence?.reason,
            feeEvidence: input.feeEvidence?.evidence,
            reason: input.reason,
            evidence: input.evidence,
            correctsEvidenceId: input.correctsEvidenceId,
            reversesEvidenceId: input.reversesEvidenceId,
            payloadHash,
            actorKey: actorKey(command.actor),
            commandId: command.commandId,
          },
        })
        await db.settlementEvidenceSource.update({
          where: { id: source.id },
          data: { revision: { increment: 1 } },
        })
        return { evidenceId: observation.id, sourceId: source.id, duplicate: false }
      })
      if (!result.duplicate)
        command.emit({
          aggregateType: "settlement_evidence",
          aggregateId: result.sourceId,
          type: "settlement.evidence_recorded",
          payload: {
            evidenceId: result.evidenceId,
            sourceId: result.sourceId,
            state: input.state,
            correctsEvidenceId: input.correctsEvidenceId ?? null,
            reversesEvidenceId: input.reversesEvidenceId ?? null,
          },
        })
      return result
    }),
})

/** Called under the organization's lock by both preview and commit. No amount/date matching. */
export async function previewEvidenceDecision(
  db: Prisma.TransactionClient,
  organizationId: string,
  input: SettlementEvidenceDecision,
) {
  const { observation, source } = await loadEvidenceSource(db, organizationId, input.evidenceId)
  const received = activeReceived(source.observations)
  const returned = source.observations.some((row) => row.state === "returned")
  const receiptId = "receiptId" in input ? input.receiptId : source.receiptId
  const receipt = receiptId
    ? await db.settlementReceipt.findFirst({ where: { id: receiptId, organizationId } })
    : null
  if (receiptId && !receipt) return refuse("receipt_not_found", "Receipt not found")
  if (receipt?.contactId !== undefined && receipt.contactId !== source.contactId)
    return refuse("customer_mismatch", "Evidence and receipt must belong to the same customer")
  if (receipt?.reversedAt && input.action !== "unmatch")
    return refuse("receipt_reversed", "Receipt was already reversed")
  if (input.action === "match" || input.action === "confirm") {
    if (
      source.source === "client" ||
      observation.state !== "received" ||
      !received.some((row) => row.id === observation.id)
    )
      return refuse(
        "evidence_not_received",
        "Only current received bank or provider evidence can verify cash",
      )
    if (returned) return refuse("evidence_returned", "Returned evidence cannot verify a receipt")
    if (source.receiptId)
      return refuse("evidence_already_matched", "This source transaction already has a receipt")
    if (
      input.identity.kind !== "remittance_document" &&
      input.identity.value !== source.transactionReference
    )
      return refuse("identity_mismatch", "The identity must name the source transaction")
    if (input.action === "confirm") {
      const priorMatches = source.decisions.filter(
        (row) => row.action === "match" || row.action === "confirm",
      )
      const previousIds = [...new Set(priorMatches.map((row) => row.receiptId))]
      const previousReceipts = await db.settlementReceipt.findMany({
        where: { id: { in: previousIds }, organizationId },
      })
      const returnedReceipt = await db.settlementEvidenceDecision.findFirst({
        where: { receiptId: { in: previousIds }, action: "return" },
      })
      const correctedSince = source.observations.some(
        (row) => row.correctsEvidenceId && row.revision > (priorMatches.at(-1)?.revision ?? 0),
      )
      if (
        returnedReceipt ||
        previousReceipts.some((row) => !row.reversedAt) ||
        (previousIds.length > 0 && !correctedSince)
      )
        return refuse(
          "source_receipt_exists",
          "This evidence already created or verified a receipt. Rematch it, or reverse it and explicitly correct its evidence.",
        )
    }
    if (source.createdReceiptId && source.createdReceiptId !== receiptId) {
      const previousReceipt = await db.settlementReceipt.findUniqueOrThrow({
        where: { id: source.createdReceiptId },
      })
      const confirmation = source.decisions.filter((row) => row.action === "confirm").at(-1)
      const correctedSince = source.observations.some(
        (row) => row.correctsEvidenceId && row.revision > (confirmation?.revision ?? 0),
      )
      if (!previousReceipt.reversedAt || !correctedSince)
        return refuse(
          "source_receipt_exists",
          "This evidence already created a receipt. Rematch that receipt, or reverse it and explicitly correct its evidence.",
        )
    }
    if (
      receipt &&
      (receipt.currency !== observation.currency ||
        !receipt.netAmount.equals(observation.netAmount) ||
        !receipt.feeAmount.equals(observation.feeAmount))
    )
      return refuse(
        "receipt_amount_mismatch",
        "Receipt currency, net and fee must each match the evidence",
      )
    // Never materialize a second cash record for an already handled legacy Stripe payment.
    if (
      source.source === "provider" &&
      (await db.payment.findFirst({
        where: {
          organizationId,
          receiptId: null,
          OR: [
            { stripePaymentIntentId: source.transactionReference },
            { stripeCheckoutSessionId: source.transactionReference },
          ],
        },
      }))
    )
      return refuse(
        "legacy_payment_exists",
        "This provider transaction is already recorded as a legacy payment",
      )
  } else {
    if (!receipt) return refuse("receipt_not_found", "Receipt not found")
    if (source.receiptId !== receipt.id) {
      if (input.action !== "return" || source.receiptId || !input.identity)
        return refuse(
          "match_changed",
          "The current evidence match changed. An unmatched return needs explicit receipt identity evidence.",
        )
      if (
        input.identity.kind !== "remittance_document" &&
        input.identity.value !== source.transactionReference
      )
        return refuse("identity_mismatch", "The identity must name the source transaction")
      if (source.createdReceiptId && source.createdReceiptId !== receipt.id)
        return refuse("source_receipt_exists", "Return the original source-created receipt")
    }
    if (input.action === "return") {
      if (
        receipt.currency !== observation.currency ||
        !receipt.netAmount.equals(observation.netAmount) ||
        !receipt.feeAmount.equals(observation.feeAmount)
      )
        return refuse(
          "receipt_amount_mismatch",
          "Receipt currency, net and fee must each match the return evidence",
        )
      if (
        observation.state !== "returned" ||
        !received.some(
          (row) => row.id === observation.reversesEvidenceId && sameAmounts(row, observation),
        )
      )
        return refuse("return_reference_invalid", "Select linked return evidence for this receipt")
    } else if (returned)
      return refuse("return_pending", "Apply the linked return before changing its receipt match")
  }
  const balance = receipt ? await receiptBalance(db, receipt) : null
  if (input.action === "return" && balance && !balance.refunded.isZero())
    return refuse(
      "receipt_refunds_pending",
      "Resolve recorded refunds before applying a full return",
    )
  const allocations = receipt
    ? await db.payment.findMany({
        where: { receiptId: receipt.id, voidedAt: null },
        orderBy: { id: "asc" },
        include: { invoice: true },
      })
    : []
  const invoices = [
    ...new Map(allocations.map((row) => [row.invoiceId, row.invoice])).values(),
  ].map((invoice) => {
    const restored = allocations
      .filter((row) => row.invoiceId === invoice.id)
      .reduce((sum, row) => sum.plus(row.amount), new Prisma.Decimal(0))
    const before = computeSettlement(invoice).balanceDue.toFixed(2)
    const after =
      input.action === "return"
        ? computeSettlement({
            ...invoice,
            amountPaid: invoice.amountPaid.minus(restored),
          }).balanceDue.toFixed(2)
        : before
    return { invoiceId: invoice.id, currency: invoice.currency, before, after }
  })
  const plan = {
    sourceId: source.id,
    evidenceId: observation.id,
    revision: source.revision,
    action: input.action,
    receiptId: receipt?.id ?? null,
    currency: observation.currency,
    netAmount: observation.netAmount.toFixed(2),
    feeAmount: observation.feeAmount.toFixed(2),
    grossAmount: observation.netAmount.plus(observation.feeAmount).toFixed(2),
    cashChange:
      input.action === "confirm"
        ? observation.netAmount.toFixed(2)
        : input.action === "return"
          ? observation.netAmount.negated().toFixed(2)
          : "0.00",
    availableBefore: balance?.available.toFixed(2) ?? null,
    availableAfter:
      input.action === "return"
        ? "0.00"
        : input.action === "confirm"
          ? observation.netAmount.plus(observation.feeAmount).toFixed(2)
          : (balance?.available.toFixed(2) ?? null),
    invoices,
    customerCreditAfter:
      input.action === "return"
        ? { reason: null, evidence: null }
        : receipt
          ? { reason: receipt.creditReason, evidence: receipt.creditEvidence }
          : null,
    customerCreditBefore: receipt
      ? { reason: receipt.creditReason, evidence: receipt.creditEvidence }
      : null,
    allocations: allocations.map((row) => ({
      paymentId: row.id,
      invoiceId: row.invoiceId,
      invoiceCurrency: row.currency,
      invoiceAmount: row.amount.toFixed(2),
      receiptAmount: row.receiptAmount!.toFixed(2),
      amountPaid: row.invoice.amountPaid.toFixed(2),
      amountCredited: row.invoice.amountCredited.toFixed(2),
      totalGross: row.invoice.totalGross.toFixed(2),
    })),
  }
  return { ...plan, previewToken: hash({ input, plan }) }
}

export const decideSettlementEvidence = defineCommand({
  type: "settlement.decide_evidence",
  permission: "payment:create",
  outwardFacing: true,
  requiresApproval: personOnly,
  input: settlementEvidenceCommitSchema,
  summarize: (input) => `${input.decision.action} settlement evidence ${input.decision.evidenceId}`,
  handle: (input) =>
    Effect.gen(function* () {
      const decision = input.decision
      yield* authorize(
        decision.action === "return" || decision.action === "unmatch"
          ? "payment:void"
          : "payment:create",
      )
      const db = yield* Db
      const command = yield* Command
      const plan = yield* run(() => previewEvidenceDecision(db, command.organizationId, decision))
      if (plan.previewToken !== input.previewToken)
        return yield* new InvalidState({
          code: "settlement_preview_changed",
          message: "Evidence, balances or classification changed. Review a new preview.",
        })
      const { observation, source } = yield* run(() =>
        loadEvidenceSource(db, command.organizationId, decision.evidenceId),
      )
      let receiptId = plan.receiptId
      if (decision.action === "confirm") {
        // Compose the existing money handler inside this transaction and command, never a second transaction.
        const receipt = yield* recordReceipt.handle({
          requestId: decision.requestId,
          contactId: source.contactId,
          currency: observation.currency,
          netAmount: observation.netAmount.toFixed(2),
          feeAmount: observation.feeAmount.toFixed(2),
          paidAt: observation.occurredAt.toISOString(),
          method: decision.method,
          reference: `evidence:${source.id}:${observation.id}`,
          reason: decision.reason,
          evidence: decision.evidence,
          ...(observation.feeReason && observation.feeEvidence
            ? { feeEvidence: { reason: observation.feeReason, evidence: observation.feeEvidence } }
            : {}),
        })
        receiptId = receipt.receiptId
      }
      if (!receiptId)
        return yield* new InvalidState({ code: "receipt_not_found", message: "Receipt not found" })
      if (decision.action === "return") {
        for (const allocation of plan.allocations) {
          const change = {
            requestId: decision.requestId,
            action: "reverse_allocation" as const,
            paymentId: allocation.paymentId,
            reason: decision.reason,
            evidence: decision.evidence,
          }
          const preview = yield* Effect.promise(() =>
            previewReceiptChange(db, command.organizationId, change),
          )
          yield* changeReceipt.handle({ ...change, previewToken: preview.previewToken })
        }
        const change = {
          requestId: decision.requestId,
          action: "reverse_receipt" as const,
          receiptId,
          reason: decision.reason,
          evidence: decision.evidence,
        }
        const preview = yield* Effect.promise(() =>
          previewReceiptChange(db, command.organizationId, change),
        )
        yield* changeReceipt.handle({ ...change, previewToken: preview.previewToken })
      }
      const recorded = yield* Effect.promise(() =>
        db.settlementEvidenceDecision.create({
          data: {
            sourceId: source.id,
            evidenceId: observation.id,
            receiptId,
            revision: source.revision + 1,
            action: decision.action,
            reason: decision.reason,
            evidence: decision.evidence,
            ...("identity" in decision && decision.identity ? { identity: decision.identity } : {}),
            actorKey: actorKey(command.actor),
            commandId: command.commandId,
          },
        }),
      )
      yield* Effect.promise(() =>
        db.settlementEvidenceSource.update({
          where: { id: source.id },
          data: {
            receiptId: decision.action === "unmatch" ? null : receiptId,
            ...(decision.action === "confirm" ? { createdReceiptId: receiptId } : {}),
            revision: { increment: 1 },
          },
        }),
      )
      command.emit({
        aggregateType: "settlement_evidence",
        aggregateId: source.id,
        type: "settlement.evidence_decided",
        payload: {
          decisionId: recorded.id,
          sourceId: source.id,
          evidenceId: observation.id,
          receiptId,
          action: decision.action,
        },
      })
      return { receiptId, decisionId: recorded.id, action: decision.action }
    }),
})

export const provenanceCommands = [recordSettlementEvidence, decideSettlementEvidence] as const
