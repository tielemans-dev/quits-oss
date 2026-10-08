import {
  authorizationServerMetadata,
  getMcpOAuthContext,
  handleAuthorize,
  handleRegister,
  handleRevoke,
  handleToken,
  protectedResourceMetadata,
} from "./server"

const notFound = () => new Response("Not found", { status: 404 })

/** Discovery documents are public and cacheable; clients fetch them across origins. */
function metadataResponse(body: unknown) {
  return Response.json(body, {
    headers: { "cache-control": "public, max-age=300", "access-control-allow-origin": "*" },
  })
}

export function handleProtectedResourceMetadataRequest() {
  const context = getMcpOAuthContext()
  return context ? metadataResponse(protectedResourceMetadata(context)) : notFound()
}

export function handleAuthorizationServerMetadataRequest() {
  const context = getMcpOAuthContext()
  return context ? metadataResponse(authorizationServerMetadata(context)) : notFound()
}

/** `/api/mcp/oauth/<endpoint>`. Every endpoint answers 404 while the prototype is off. */
export async function handleOAuthEndpointRequest(request: Request, endpoint: string) {
  const context = getMcpOAuthContext()
  if (!context) return notFound()
  switch (`${request.method} ${endpoint}`) {
    case "GET authorize":
      return handleAuthorize(context, request)
    case "POST token":
      return handleToken(context, request)
    case "POST register":
      return handleRegister(context, request)
    case "POST revoke":
      return handleRevoke(context, request)
    default:
      return notFound()
  }
}
