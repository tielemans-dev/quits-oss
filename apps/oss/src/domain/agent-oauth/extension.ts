/**
 * PROTOTYPE extension contract (issue #31) for deployments whose MCP tokens are issued somewhere
 * other than the built-in authorization server, such as a gateway in front of the app.
 *
 * A verifier receives a bearer token the built-in server did not issue and either returns the
 * grant it represents or null. It never authorizes anything by itself: the MCP endpoint still
 * checks that the token's `resource` is this server, loads the named agent key as it is now
 * (revoked, expired and departed-owner keys fail) and narrows the key's scopes to the token's.
 * So a verifier can only ever map a token to an installation people created through consent.
 */
export type McpAccessTokenGrant = {
  /** The agent key (installation) the token acts as. */
  agentKeyId: string
  /** Scopes the token carries. Anything the agent key lacks is ignored. */
  scopes: string[]
  clientId: string
  /** The audience the token was issued for; must equal this server's canonical MCP URI. */
  resource: string
}

export type McpAccessTokenVerifier = (
  token: string,
  context: { resource: string; now: Date }
) => Promise<McpAccessTokenGrant | null>

let verifiers: McpAccessTokenVerifier[] = []

export function setMcpAccessTokenVerifiers(next: McpAccessTokenVerifier[]) {
  verifiers = [...next]
}

export async function runAccessTokenVerifiers(token: string, context: { resource: string; now: Date }) {
  for (const verify of verifiers) {
    const grant = await verify(token, context)
    if (grant) return grant
  }
  return null
}
