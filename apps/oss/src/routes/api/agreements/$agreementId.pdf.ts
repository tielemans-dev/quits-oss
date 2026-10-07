import { createFileRoute } from "@tanstack/react-router"
export const Route = createFileRoute("/api/agreements/$agreementId/pdf")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const { privateAgreementPdf } = await import("../../../lib/agreements/pdf-access")
        return privateAgreementPdf(request, params.agreementId)
      },
    },
  },
})
