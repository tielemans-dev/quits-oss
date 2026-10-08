import { createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute("/c/$token_/logo")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const { publicClientActionLogo } = await import("../lib/documents/public-logo-access")
        return publicClientActionLogo(params.token)
      },
    },
  },
})
