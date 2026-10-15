import type { DocumentRenderer, RenderInput } from "../runtime/services"
import { appLogger } from "../observability"

const documentsLogger = appLogger.child("documents")

/** Report at the renderer boundary so issuance and previews keep the same failure behavior. */
export async function renderPdf(renderer: DocumentRenderer, input: RenderInput) {
  try {
    return await renderer.renderPdf(input)
  } catch (error) {
    documentsLogger.error("document.pdf_render_failed", {
      organizationId: input.organizationId,
      documentId: input.documentId,
      documentKind: input.kind,
      rendererVersion: renderer.version,
      errorType: error instanceof Error ? error.name : "UnknownError",
    })
    throw error
  }
}
