import { agreementPublicDecisionSchema, deliverablePublicDecisionSchema } from "@quits/contracts/agreements"
import { prisma } from "../db"
import { InvalidState } from "../../domain/errors"
import { executeCommand } from "../../domain/execute"
import { recordAgreementCustomerDecision } from "../../domain/commands/agreement-lifecycle"
import { recordPublicLinkAttempt } from "../public-links/rate-limit"
import { publicAcceptDeliverable, publicRequestDeliverableChanges } from "../../domain/commands/public-deliverables"
import { publicAgreementDto, publicDeliverableDto } from "./public"
import { verifyAgreementPublicToken, getAgreementPublicSecret, mintAgreementLink } from "./tokens"

export async function loadPublicAgreementByToken(
  token: string,
  secret = getAgreementPublicSecret(),
  now = new Date(),
) {
  const payload = verifyAgreementPublicToken(token, secret)
  if (!payload || now >= new Date(payload.exp)) return null
  const agreement = await prisma.agreement.findUnique({
    where: { id: payload.agreementId },
    include: {
      deliverables: { orderBy: { sortOrder: "asc" } },
    },
  })
  if (
    !agreement ||
    !agreement.offerSnapshot ||
    agreement.publicAccessKeyVersion !== payload.keyVersion
  )
    return null
  if (payload.scope === "decide") {
    if (
      agreement.status !== "sent" ||
      agreement.offerRevision !== payload.offerRevision ||
      !agreement.expiresAt ||
      now >= agreement.expiresAt
    )
      return null
  } else if (payload.scope === "sign_off") {
    const line = agreement.deliverables.find(line => line.id === payload.deliverableId)
    if (agreement.status !== "accepted" || !line || line.isDeposit || line.deliveryRevision !== payload.deliveryRevision ||
      !["delivered", "accepted", "changes_requested"].includes(line.status)) return null
  } else if (
    !agreement.acceptedAt ||
    !["accepted", "completed", "cancelled"].includes(agreement.status)
  )
    return null
  return { agreement, payload }
}
export async function decidePublicAgreementByToken(
  token: string,
  decision: unknown,
  evidence: { ip?: string | null; userAgent?: string | null } = {},
  now = new Date(),
) {
  const payload = verifyAgreementPublicToken(token, getAgreementPublicSecret())
  if (!payload || payload.scope !== "decide")
    throw new InvalidState({
      code: "invalid",
      message: "This link is no longer valid",
    })
  await recordPublicLinkAttempt(
    {
      documentKind: "agreement",
      documentId: payload.agreementId,
      scope: payload.scope,
      keyVersion: payload.keyVersion,
      targetId: null,
      revision: payload.offerRevision,
    },
    now,
  )
  const parsed = agreementPublicDecisionSchema.parse(decision)
  const target = await prisma.agreement.findUnique({
    where: { id: payload.agreementId },
    select: { organizationId: true },
  })
  if (!target)
    throw new InvalidState({
      code: "invalid",
      message: "This link is no longer valid",
    })
  const outcome = await executeCommand(
    recordAgreementCustomerDecision,
    { token, decision: parsed, ...evidence },
    {
      actor: {
        kind: "system",
        reason: "customer_link",
        organizationId: target.organizationId,
        label: "Customer (public agreement link)",
      },
      now,
    },
  )
  if (outcome.status !== "completed")
    throw new InvalidState({
      code: outcome.status === "failed" ? (outcome.error.code ?? "invalid") : "retry_later",
      message: outcome.status === "failed" ? outcome.error.message : "Please try again later",
    })
  const agreement = outcome.result
  return {
    document: publicAgreementDto(agreement),
    scope: agreement.acceptedAt ? ("read" as const) : ("decide" as const),
    readLink: agreement.acceptedAt ? mintAgreementLink(agreement, "read", now) : null,
  }
}

export async function decidePublicDeliverableByToken(token: string, decision: unknown, now = new Date()) {
  const payload = verifyAgreementPublicToken(token, getAgreementPublicSecret())
  if (!payload || payload.scope !== "sign_off") throw new InvalidState({ code: "invalid", message: "This link is no longer valid" })
  await recordPublicLinkAttempt({
    documentKind: "agreement", documentId: payload.agreementId, scope: payload.scope,
    keyVersion: payload.keyVersion, targetId: payload.deliverableId, revision: payload.deliveryRevision,
  }, now)
  const parsed = deliverablePublicDecisionSchema.parse(decision)
  const target = await prisma.agreement.findUnique({ where: { id: payload.agreementId }, select: { organizationId: true } })
  if (!target) throw new InvalidState({ code: "invalid", message: "This link is no longer valid" })
  const options = { actor: { kind: "system" as const, reason: "customer_link" as const, organizationId: target.organizationId, label: "Customer (public sign-off link)" }, now }
  const outcome = parsed.decision === "accept"
    ? await executeCommand(publicAcceptDeliverable, { token, confirmed: parsed.confirmed }, options)
    : await executeCommand(publicRequestDeliverableChanges, { token, note: parsed.note }, options)
  if (outcome.status !== "completed") throw new InvalidState({
    code: outcome.status === "failed" ? outcome.error.code ?? "invalid" : "retry_later",
    message: outcome.status === "failed" ? outcome.error.message : "Please try again later",
  })
  return { scope: "sign_off" as const, deliverable: publicDeliverableDto(outcome.result.agreement, outcome.result.line) }
}
