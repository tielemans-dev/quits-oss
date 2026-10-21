import { getDocumentArtifactStore } from "../runtime/services"
import { hashBytes } from "../../domain/documents/hash"
import { appLogger } from "../observability"

/** Keeps the base64 message under common 10 MB SMTP limits; Resend allows 40 MB. */
export const MAX_PDF_ATTACHMENT_BYTES = 7 * 1024 * 1024

export type PdfAttachment = { filename: string; content: string; contentType: "application/pdf" }
export type StoredPdfProblem = "not_stored" | "unavailable" | "hash_mismatch" | "too_large"

const attachmentLogger = appLogger.child("document-email")

export const pdfFilename = (number: string) => `${number.replace(/[^a-zA-Z0-9_-]/g, "_")}.pdf`

/** The stored bytes only while they match the hash recorded when the document was issued. */
export async function readStoredPdf(ref: string | null | undefined, hash: string | null | undefined):
  Promise<{ bytes: Uint8Array } | { bytes: null; reason: StoredPdfProblem }> {
  if (!ref || !hash) return { bytes: null, reason: "not_stored" }
  const bytes = await getDocumentArtifactStore()?.get(ref).catch(() => null)
  if (!bytes) return { bytes: null, reason: "unavailable" }
  if (hashBytes(bytes) !== hash) return { bytes: null, reason: "hash_mismatch" }
  return { bytes }
}

/**
 * The issued PDF as an email attachment, or null when it cannot be attached. A fresh render is never
 * substituted for the issued document: the email goes out without it and the reason is logged.
 */
export async function storedPdfAttachment(input: {
  ref: string | null | undefined
  hash: string | null | undefined
  number: string
  log: { organizationId: string; documentKind: "invoice" | "creditNote"; documentId: string }
}): Promise<PdfAttachment | null> {
  const stored = await readStoredPdf(input.ref, input.hash)
  const reason = stored.bytes ? (stored.bytes.byteLength > MAX_PDF_ATTACHMENT_BYTES ? "too_large" : null) : stored.reason
  if (reason || !stored.bytes) {
    // Expected where no renderer or artifact store is configured; anything else lost the issued file.
    if (reason === "not_stored") attachmentLogger.info("document.email.pdf_not_attached", { ...input.log, reason })
    else attachmentLogger.warn("document.email.pdf_not_attached", { ...input.log, reason })
    return null
  }
  return { filename: pdfFilename(input.number), content: Buffer.from(stored.bytes).toString("base64"), contentType: "application/pdf" }
}
