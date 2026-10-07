import { createFileRoute } from "@tanstack/react-router"
export const Route = createFileRoute("/api/documents/$kind/$documentId/pdf")({
  server: { handlers: { GET: async ({ request, params }) => {
    const { privateDocumentPdf } = await import("../../../../lib/documents/pdf-access")
    return privateDocumentPdf(request, params.kind, params.documentId)
  } } },
})
