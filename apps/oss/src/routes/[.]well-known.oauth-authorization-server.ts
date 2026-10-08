import { createFileRoute } from "@tanstack/react-router"

async function handle() {
  const { handleAuthorizationServerMetadataRequest } = await import("../domain/agent-oauth/http")
  return handleAuthorizationServerMetadataRequest()
}

/** RFC 8414 authorization server metadata (sign-in prototype, issue #31). */
export const Route = createFileRoute("/.well-known/oauth-authorization-server")({
  server: { handlers: { GET: handle } },
})
