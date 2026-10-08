import { documentPdf, storedPdfResponse } from "../documents/pdf-access"
import { findGrant, resolveClientActionAccess } from "./access"
import { loadGrantedAgreement, loadGrantedInvoice } from "./page"

const gone = () => new Response("This link is no longer valid", { status: 404, headers: { "Cache-Control": "private, no-store" } })

/**
 * The final document of a record the link may view: the issued invoice or agreement PDF. Needs a
 * `view` grant; revoked, expired or foreign records answer exactly like an unknown one.
 */
export async function clientActionDownload(token: string, kind: string, recordId: string) {
  const access = await resolveClientActionAccess(token)
  if (access.status !== "active") return gone()
  const { link } = access
  if (kind === "invoice") {
    const grant = findGrant(link, "invoice", recordId, "view")
    if (!grant) return gone()
    const loaded = await loadGrantedInvoice(link, grant)
    if (loaded.state !== "ready") return gone()
    return documentPdf("invoice", loaded.invoice.id, link.organizationId)
  }
  if (kind === "agreement") {
    const grant = findGrant(link, "agreement", recordId, "view")
    if (!grant) return gone()
    const loaded = await loadGrantedAgreement(link, grant)
    if (loaded.state !== "ready") return gone()
    return (await storedPdfResponse(loaded.agreement)) ?? new Response("Stored artifact unavailable", { status: 503 })
  }
  return gone()
}
