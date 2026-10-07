import { createFileRoute } from "@tanstack/react-router"
export const Route = createFileRoute("/a/$token_/pdf")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const { publicAgreementPdf } = await import("../lib/agreements/pdf-access")
        return publicAgreementPdf(params.token)
      },
    },
  },
})
