import { createFileRoute } from "@tanstack/react-router"

async function handle(request: Request) {
  const { handleMcpRequest } = await import("../../domain/agent-tools/mcp")
  return handleMcpRequest(request)
}

/** Model Context Protocol endpoint for agent keys (Streamable HTTP, stateless). */
export const Route = createFileRoute("/api/mcp")({
  server: {
    handlers: {
      POST: ({ request }: { request: Request }) => handle(request),
      GET: ({ request }: { request: Request }) => handle(request),
      DELETE: ({ request }: { request: Request }) => handle(request),
    },
  },
})
