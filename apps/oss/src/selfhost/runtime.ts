import { buildUblDocument, validateEinvoice } from "../lib/exports/ubl"
import { createElement } from "react"
import { renderToBuffer } from "@react-pdf/renderer"
import { readProductEnv } from "@quits/shared/runtimeEnv"
import { InvoicePdfDocument } from "../lib/invoice-pdf"
import { CreditNotePdfDocument } from "../lib/credit-note-pdf"
import { AgreementPdf } from "../lib/agreement-pdf"
import { localDiskArtifactStore } from "./artifact-store"
import type { DocumentRenderer, RuntimeServices } from "../lib/runtime/services"

export const selfhostDocumentRenderer: DocumentRenderer = {
  version: "quits-documents-v3",
  async renderUbl(input) {
    if (!input.ubl || validateEinvoice(input.ubl).length) return null
    return new TextEncoder().encode(buildUblDocument(input.ubl))
  },
  async renderPdf(input) {
    const document = input.kind === "invoice" ? createElement(InvoicePdfDocument, input.pdf)
      : input.kind === "creditNote" ? createElement(CreditNotePdfDocument, input.pdf)
      : createElement(AgreementPdf, input.pdf)
    return new Uint8Array(await renderToBuffer(document as Parameters<typeof renderToBuffer>[0]))
  },
}

export { localDiskArtifactStore }
export function selfhostRuntimeServices(env: Record<string, string | undefined> = process.env): Partial<RuntimeServices> {
  return { documentRenderer: selfhostDocumentRenderer,
    documentArtifactStore: localDiskArtifactStore(readProductEnv(env, "ARTIFACT_DIR")?.trim() || "./data/artifacts") }
}
