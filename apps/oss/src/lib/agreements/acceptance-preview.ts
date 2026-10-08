import { createHash } from "node:crypto"
import type { Agreement } from "../../../generated/prisma/client"

export function acceptanceRecipients(companyEmail: string | null | undefined, issuedToEmail: string | null) {
  return [...new Set([companyEmail?.trim(), issuedToEmail].filter((email): email is string => Boolean(email)))]
}

/** Review identity is separate from the long-lived link, so existing links can load a fresh review. */
export function publicAcceptancePreview(
  agreement: Pick<Agreement, "id" | "organizationId" | "offerRevision" | "offerSnapshotHash" | "publicAccessKeyVersion" | "issuedToEmail">,
  companyEmail?: string | null,
) {
  const recipients = acceptanceRecipients(companyEmail, agreement.issuedToEmail)
  const version = createHash("sha256").update(JSON.stringify([
    "agreement-acceptance-v1", agreement.organizationId, agreement.id, agreement.offerRevision,
    agreement.offerSnapshotHash, agreement.publicAccessKeyVersion, [...recipients].sort(),
  ])).digest("hex")
  return { revision: agreement.offerRevision, recipients, version }
}
