import { createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute("/pay/$token_/logo")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const { publicInvoiceLogo } = await import("../lib/documents/public-logo-access")
        return publicInvoiceLogo(params.token)
      },
    },
  },
})
