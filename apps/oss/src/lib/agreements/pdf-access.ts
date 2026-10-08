import { storedPdfResponse } from "../documents/pdf-access"
import { agreementOfferSnapshotSchema } from "@quits/contracts/agreements"
import { auth } from "../auth"
import { prisma } from "../db"
import { actorCan } from "../../domain/actor"
import { resolveUserActor } from "../../domain/user-actor"
import { agreementPdfResponse } from "../agreement-pdf"
import { loadPublicAgreementByToken } from "./public-access"

export async function agreementPdfActor(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers })
  const organizationId = session?.session.activeOrganizationId
  if (!session || !organizationId) return null
  const actor = await resolveUserActor({ organizationId, userId: session.user.id })
  return actor && actorCan(actor, "agreement:read") ? actor : null
}
export async function publicAgreementPdf(token: string) {
  const session = await loadPublicAgreementByToken(token)
  if (!session || session.payload.scope === "sign_off") return new Response("This link is no longer valid", { status: 404 })
  return await storedPdfResponse(session.agreement) ?? new Response("Stored artifact unavailable", { status: 503 })
}
export async function privateAgreementPdf(request: Request, id: string) {
  const actor = await agreementPdfActor(request)
  if (!actor) return new Response("Unauthorized", { status: 401 })
  const agreement = await prisma.agreement.findFirst({
    where: { id, organizationId: actor.organizationId },
  })
  if (!agreement?.offerSnapshot) return new Response("Agreement not found", { status: 404 })
  return await storedPdfResponse(agreement) ?? new Response("Stored artifact unavailable", { status: 503 })
}
export async function approvalAgreementPdf(request: Request, id: string) {
  const session = await auth.api.getSession({ headers: request.headers })
  const organizationId = session?.session.activeOrganizationId
  if (!session || !organizationId) return new Response("Unauthorized", { status: 401 })
  const actor = await resolveUserActor({ organizationId, userId: session.user.id })
  const approval = await prisma.approvalRequest.findFirst({ where: { id, organizationId }, select: { commandType: true, reviewContext: true } })
  if (!approval) return new Response("Preview not found", { status: 404 })
  const permission = approval.commandType === "invoice.send" ? "invoice:read" : "agreement:read"
  if (!actor || !actorCan(actor, permission)) return new Response("Forbidden", { status: 403 })
  const review = approval.reviewContext as { documentPreview?: import("../../domain/documents/render-input").RenderInput; preview?: { snapshot?: unknown } } | null
  if (review?.documentPreview) {
    const { renderPdfResponse } = await import("../documents/pdf-access")
    return renderPdfResponse(review.documentPreview, false)
  }
  const snapshot = agreementOfferSnapshotSchema.safeParse(review?.preview?.snapshot)
  if (!snapshot.success) return new Response("Preview not found", { status: 404 })
  return agreementPdfResponse({ snapshot: snapshot.data })
}
