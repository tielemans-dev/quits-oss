import { createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute("/q/$token_/logo")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const { publicQuoteLogo } = await import("../lib/documents/public-logo-access")
        return publicQuoteLogo(params.token)
      },
    },
  },
})
