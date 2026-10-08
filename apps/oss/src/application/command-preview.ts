import { InvalidState } from "../domain/errors"
import type { previewCommand } from "../domain/preview"

/** Render only the allowlisted customer artifact, never reserve it or put it in storage. */
export async function presentCommandPreview(preview: Awaited<ReturnType<typeof previewCommand>>, includeDocument: boolean) {
  const { documentPreview, ...review } = preview.review
  let document: { mimeType: "application/pdf"; base64: string } | null = null
  if (includeDocument) {
    let bytes: Uint8Array | null = null
    if (documentPreview) {
      const { getDocumentRenderer } = await import("../lib/runtime/services")
      const renderer = getDocumentRenderer()
      if (!renderer) throw new InvalidState({ code: "renderer_unavailable", message: "Document renderer unavailable for preview" })
      bytes = await renderer.renderPdf(documentPreview)
    } else if (review.preview) {
      const { agreementPdfResponse } = await import("../lib/agreement-pdf")
      const response = await agreementPdfResponse({ snapshot: review.preview.snapshot })
      if (!response.ok) throw new InvalidState({ code: "renderer_unavailable", message: "Document renderer unavailable for preview" })
      bytes = new Uint8Array(await response.arrayBuffer())
    }
    if (bytes) document = { mimeType: "application/pdf", base64: Buffer.from(bytes).toString("base64") }
  }
  return { ...preview, review, hasDocumentPreview: Boolean(documentPreview || review.preview), document }
}
