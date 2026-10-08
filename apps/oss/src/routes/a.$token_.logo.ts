import { createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute("/a/$token_/logo")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const { publicAgreementLogo } = await import("../lib/documents/public-logo-access")
        return publicAgreementLogo(params.token)
      },
    },
  },
})
