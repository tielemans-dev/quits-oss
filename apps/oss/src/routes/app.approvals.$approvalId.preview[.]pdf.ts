import { createFileRoute } from "@tanstack/react-router"
export const Route = createFileRoute("/app/approvals/$approvalId/preview.pdf")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const { approvalAgreementPdf } = await import("../lib/agreements/pdf-access")
        return approvalAgreementPdf(request, params.approvalId)
      },
    },
  },
})
