import { createFileRoute } from "@tanstack/react-router"
export const Route = createFileRoute("/pay/$token_/pdf")({
  server: { handlers: { GET: async ({ params }) => {
    const { publicInvoicePdf } = await import("../lib/documents/pdf-access")
    return publicInvoicePdf(params.token)
  } } },
})
