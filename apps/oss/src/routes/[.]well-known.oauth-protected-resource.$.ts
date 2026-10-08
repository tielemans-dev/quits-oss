import { createFileRoute } from "@tanstack/react-router"

async function handle({ params }: { params: { _splat?: string } }) {
  // Only the MCP endpoint is a protected resource; other paths have no metadata.
  if (params._splat !== "api/mcp") return new Response("Not found", { status: 404 })
  const { handleProtectedResourceMetadataRequest } = await import("../domain/agent-oauth/http")
  return handleProtectedResourceMetadataRequest()
}

/** Path-suffixed RFC 9728 metadata: `/.well-known/oauth-protected-resource/api/mcp`. */
export const Route = createFileRoute("/.well-known/oauth-protected-resource/$")({
  server: { handlers: { GET: handle } },
})
