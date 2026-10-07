import { prisma } from "../db"
import { auth } from "../auth"
import { resolveUserActor } from "../../domain/user-actor"
import { actorCan } from "../../domain/actor"
import { getDocumentArtifactStore, getDocumentRenderer } from "../runtime/services"
import { runArtifactRead } from "../../application/issuance"
import { prospectiveRenderInput, hashBytes, type RenderInput, type ArtifactDocumentKind } from "../../domain/documents/render-input"
import type { Permission } from "../../domain/permissions"
import { schedulerActor } from "../../domain/commands/reminders"

const headers = (artifact: string, number: string) => ({
  "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${number.replace(/[^a-zA-Z0-9_-]/g, "_")}.pdf"`,
  "Cache-Control": "private, no-store", "X-Quits-Artifact": artifact,
})
export async function storedPdfResponse(document: { artifactPdfRef: string | null; artifactPdfHash: string | null; number: string | null }) {
  if (!document.artifactPdfRef) return null
  const bytes = await getDocumentArtifactStore()?.get(document.artifactPdfRef)
  if (!bytes || hashBytes(bytes) !== document.artifactPdfHash) return new Response("Stored artifact unavailable", { status: 503 })
  return new Response(new Uint8Array(bytes), { headers: headers("stored", document.number ?? "document") })
}
export async function renderPdfResponse(input: RenderInput, issued: boolean) {
  const renderer = getDocumentRenderer()
  if (!renderer) return new Response("Document renderer unavailable", { status: 503 })
  return new Response(new Uint8Array(await renderer.renderPdf(input)), {
    headers: headers(issued ? "reconstructed" : "live", input.number),
  })
}
export async function documentPdf(kind: ArtifactDocumentKind, id: string, organizationId: string) {
  if (kind === "creditNote") {
    const note = await prisma.creditNote.findFirst({ where: { id, organizationId }, include: {
      contact: true, invoice: { select: { number: true, issueDate: true } }, items: { orderBy: { sortOrder: "asc" } },
    } })
    if (!note) return new Response("Document not found", { status: 404 })
    const stored = await storedPdfResponse(note)
    if (stored) return stored
    return new Response("Stored artifact unavailable", { status: 503 })
  }
  const doc = kind === "invoice" ? await prisma.invoice.findFirst({ where: { id, organizationId } })
    : await prisma.agreement.findFirst({ where: { id, organizationId } })
  if (!doc) return new Response("Document not found", { status: 404 })
  // Agreements can have an issued offer while a definitely rejected email leaves them draft.
  const issued = doc.status !== "draft" || (kind === "agreement" && "offerSnapshot" in doc && !!doc.offerSnapshot)
  if (issued) return await storedPdfResponse(doc) ?? new Response("Stored artifact unavailable", { status: 503 })
  const renderInput = await runArtifactRead(prospectiveRenderInput({ kind, commandInput: { id }, documentId: id,
    preview: true, number: doc.number ?? "draft", issuedAt: doc.issueDate ?? new Date() }), prisma, schedulerActor(organizationId), new Date())
  if (renderInput.kind === "invoice" && !issued) renderInput.pdf.invoice.status = "draft"
  return renderPdfResponse(renderInput, issued)
}
export async function privateDocumentPdf(request: Request, kind: string, id: string) {
  if (!["invoice", "creditNote", "agreement"].includes(kind)) return new Response("Document not found", { status: 404 })
  const session = await auth.api.getSession({ headers: request.headers })
  const organizationId = session?.session.activeOrganizationId
  if (!session || !organizationId) return new Response("Unauthorized", { status: 401 })
  const actor = await resolveUserActor({ organizationId, userId: session.user.id })
  if (!actor || !actorCan(actor, `${kind}:read` as Permission)) return new Response("Forbidden", { status: 403 })
  return documentPdf(kind as ArtifactDocumentKind, id, organizationId)
}
export async function publicInvoicePdf(token: string) {
  const { loadPublicInvoiceByToken } = await import("../payments/public-access")
  const { getPublicInvoicePaymentSecret } = await import("../payments/public")
  const session = await loadPublicInvoiceByToken(token, getPublicInvoicePaymentSecret())
  if (!session) return new Response("This link is no longer valid", { status: 404 })
  return documentPdf("invoice", session.invoice.id, session.invoice.organizationId)
}
