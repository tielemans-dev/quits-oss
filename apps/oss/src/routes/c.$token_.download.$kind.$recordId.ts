import { createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute("/c/$token_/download/$kind/$recordId")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const { clientActionDownload } = await import("../lib/client-actions/download")
        return clientActionDownload(params.token, params.kind, params.recordId)
      },
    },
  },
})
