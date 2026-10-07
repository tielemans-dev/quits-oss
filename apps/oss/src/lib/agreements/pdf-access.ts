import { storedPdfResponse } from "../documents/pdf-access"
import { agreementOfferSnapshotSchema } from "@quits/contracts/agreements"
import { auth } from "../auth"
import { prisma } from "../db"
import { actorCan } from "../../domain/actor"
import { resolveUserActor } from "../../domain/user-actor"
import { agreementPdfResponse } from "../agreement-pdf"
import { publicAgreementDto } from "./public"
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
  const dto = publicAgreementDto(session.agreement)
  const stored = await storedPdfResponse(session.agreement)
  if (stored) return stored
  const response = await agreementPdfResponse({ ...dto, snapshot: dto.snapshot })
  response.headers.set("X-Quits-Artifact", "reconstructed")
  return response
}
export async function privateAgreementPdf(request: Request, id: string) {
  const actor = await agreementPdfActor(request)
  if (!actor) return new Response("Unauthorized", { status: 401 })
  const agreement = await prisma.agreement.findFirst({
    where: { id, organizationId: actor.organizationId },
  })
  if (!agreement?.offerSnapshot) return new Response("Agreement not found", { status: 404 })
  const stored = await storedPdfResponse(agreement)
  if (stored) return stored
  const response = await agreementPdfResponse(publicAgreementDto(agreement))
  response.headers.set("X-Quits-Artifact", "reconstructed")
  return response
}
export async function approvalAgreementPdf(request: Request, id: string) {
  const actor = await agreementPdfActor(request)
  if (!actor) return new Response("Unauthorized", { status: 401 })
  const approval = await prisma.approvalRequest.findFirst({
    where: {
      id,
      organizationId: actor.organizationId,
      commandType: { in: ["agreement.send", "agreement.issue"] },
    },
    select: { reviewContext: true },
  })
  const preview = (approval?.reviewContext as { preview?: { snapshot?: unknown } } | null)?.preview
  const snapshot = agreementOfferSnapshotSchema.safeParse(preview?.snapshot)
  if (!snapshot.success) return new Response("Preview not found", { status: 404 })
  return agreementPdfResponse({ snapshot: snapshot.data })
}
