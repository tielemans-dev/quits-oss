import { createFileRoute } from "@tanstack/react-router"

async function handle() {
  const { handleProtectedResourceMetadataRequest } = await import("../domain/agent-oauth/http")
  return handleProtectedResourceMetadataRequest()
}

/** RFC 9728 protected resource metadata for the MCP endpoint (sign-in prototype, issue #31). */
export const Route = createFileRoute("/.well-known/oauth-protected-resource")({
  server: { handlers: { GET: handle } },
})
