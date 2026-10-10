/**
 * Client ID Metadata Documents as published by Claude Code and ChatGPT, fetched on 8 October 2026
 * from https://claude.ai/oauth/claude-code-client-metadata and https://chatgpt.com/oauth/client.json.
 * Tests serve them from a fake fetcher, so they never reach the network.
 */
export const claudeCodeClientMetadata = {
  client_id: "https://claude.ai/oauth/claude-code-client-metadata",
  client_name: "Claude Code",
  client_uri: "https://claude.ai",
  redirect_uris: ["http://localhost/callback", "http://127.0.0.1/callback"],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
}

export const chatGptClientMetadata = {
  client_id: "https://chatgpt.com/oauth/client.json",
  client_uri: "https://chatgpt.com/",
  redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
  token_endpoint_auth_method: "private_key_jwt",
  token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  client_name: "ChatGPT",
  logo_uri: "https://persistent.oaistatic.com/sonic/misc/openai-logo.png",
  token_endpoint_auth_signing_alg: "RS256",
  jwks_uri: "https://chatgpt.com/oauth/jwks.json",
}

export function fakeMetadataFetcher(documents: Record<string, unknown>) {
  const requested: string[] = []
  const fetcher = async (url: URL) => {
    requested.push(url.toString())
    const document = documents[url.toString()]
    return document === undefined
      ? new Response("not found", { status: 404 })
      : Response.json(document, { headers: { "cache-control": "max-age=3600" } })
  }
  return Object.assign(fetcher, { requested })
}
