import { createFileRoute } from "@tanstack/react-router"

async function handle({ request, params }: { request: Request; params: { _splat?: string } }) {
  const { handleOAuthEndpointRequest } = await import("../../domain/agent-oauth/http")
  return handleOAuthEndpointRequest(request, params._splat ?? "")
}

/** OAuth endpoints for MCP clients (sign-in prototype, issue #31): authorize, token, register, revoke. */
export const Route = createFileRoute("/api/mcp_/oauth/$")({
  server: { handlers: { GET: handle, POST: handle } },
})
