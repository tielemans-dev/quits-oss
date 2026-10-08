import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { prisma } from "../../lib/db"
import { appLogger } from "../../lib/observability"
import { actorCan, type AgentActor, type UserActor } from "../actor"
import { createAgentKey, resolveAgentActorById } from "../agent-keys"
import { Forbidden, NotFound, ValidationFailed } from "../errors"
import type { Permission } from "../permissions"
import {
  ClientRegistrationError,
  fetchMetadataDocument,
  registerDynamicClient,
  resolveClient,
  type MetadataDocumentFetcher,
} from "./clients"
import { CONSENT_PATH, OAUTH_BASE_PATH, readMcpOAuthConfig, type McpOAuthConfig } from "./config"
import { disconnectInstallation } from "./revocation"
import { runAccessTokenVerifiers } from "./extension"
import { isLoopbackOnly, matchRedirectUri } from "./redirect-uris"
import {
  OFFLINE_ACCESS,
  connectorPresets,
  formatScope,
  getConnectorPreset,
  initialChallengeScopes,
  parseScopeParameter,
  presetScopesFor,
  suggestPreset,
  supportedScopes,
  type ConnectorPresetId,
} from "./scopes"
import { InMemoryMcpOAuthStore, type McpOAuthStore, type PendingAuthorization, type RegisteredClient, type TokenFamily } from "./store"

/**
 * PROTOTYPE (issue #31): an OAuth 2.1 authorization server and resource-server checks so MCP
 * clients can connect by signing in instead of pasting an agent key.
 *
 * Every grant is an agent key, created at consent with the mode and scopes the person chose. The
 * MCP endpoint then authenticates the token to that key's agent actor, so role intersection,
 * approval gating, stale-review checks, revocation and per-key idempotency receipts are the same
 * code paths agent keys use today. Tokens are opaque and stored hashed.
 */

export type McpOAuthContext = {
  config: McpOAuthConfig
  store: McpOAuthStore
  fetchMetadata: MetadataDocumentFetcher
  now: () => Date
}

const ACCESS_TOKEN_PREFIX = "quits_at_"
const REFRESH_TOKEN_PREFIX = "quits_rt_"
const CODE_PREFIX = "quits_ac_"
const CODE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/
const logger = appLogger.child("mcp-oauth")

let configuredContext: McpOAuthContext | null | undefined

/** The prototype context, or null while the prototype is switched off. */
export function getMcpOAuthContext(): McpOAuthContext | null {
  if (configuredContext === undefined) {
    let config: McpOAuthConfig
    try {
      config = readMcpOAuthConfig()
    } catch (error) {
      // A misconfigured prototype must not take agent-key access down with it.
      logger.error("mcp_oauth.config_invalid", { error })
      configuredContext = null
      return null
    }
    configuredContext = config.enabled
      ? { config, store: new InMemoryMcpOAuthStore(), fetchMetadata: fetchMetadataDocument, now: () => new Date() }
      : null
  }
  return configuredContext
}

/** Tests and local harnesses install their own context (or null to switch the prototype off). */
export function setMcpOAuthContext(context: McpOAuthContext | null | undefined) {
  configuredContext = context
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex")
}

function secret(prefix: string) {
  return `${prefix}${randomBytes(32).toString("base64url")}`
}

function sameString(a: string, b: string) {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

/** Compares resource indicators the way RFC 8707 clients send them: case-insensitive scheme/host. */
export function sameResource(value: string | null | undefined, resource: string) {
  if (!value) return false
  try {
    const url = new URL(value)
    if (url.hash) return false
    const normalized = `${url.origin}${url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "")}${url.search}`
    return normalized === resource
  } catch {
    return false
  }
}

const noStore = { "cache-control": "no-store", pragma: "no-cache" }

function oauthError(status: number, error: string, description: string, headers: Record<string, string> = {}) {
  return Response.json({ error, error_description: description }, { status, headers: { ...noStore, ...headers } })
}

// ---------------------------------------------------------------------------------------------
// Discovery

export function protectedResourceMetadata(context: McpOAuthContext) {
  return {
    resource: context.config.resource,
    authorization_servers: [context.config.issuer],
    scopes_supported: [...initialChallengeScopes],
    bearer_methods_supported: ["header"],
    resource_name: "Quits",
  }
}

export function authorizationServerMetadata(context: McpOAuthContext) {
  const { config } = context
  const base = `${config.issuer}${OAUTH_BASE_PATH}`
  return {
    issuer: config.issuer,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    revocation_endpoint: `${base}/revoke`,
    ...(config.allowDynamicClientRegistration ? { registration_endpoint: `${base}/register` } : {}),
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [...supportedScopes, OFFLINE_ACCESS],
    client_id_metadata_document_supported: config.allowClientIdMetadataDocuments,
    authorization_response_iss_parameter_supported: true,
  }
}

/** The `WWW-Authenticate` challenge for a `401` from the MCP endpoint. */
export function bearerChallenge(context: McpOAuthContext, error?: "invalid_token") {
  const parts = [
    'Bearer realm="quits"',
    `resource_metadata="${context.config.resourceMetadataUrl}"`,
    `scope="${formatScope(initialChallengeScopes)}"`,
  ]
  if (error) parts.push(`error="${error}"`)
  return parts.join(", ")
}

/** The `WWW-Authenticate` challenge for a `403` when the grant lacks a tool's scope. */
export function insufficientScopeChallenge(context: McpOAuthContext, scopes: readonly string[]) {
  return [
    'Bearer error="insufficient_scope"',
    `scope="${formatScope(scopes)}"`,
    `resource_metadata="${context.config.resourceMetadataUrl}"`,
    'error_description="This connection was not granted the permission this tool needs"',
  ].join(", ")
}

// ---------------------------------------------------------------------------------------------
// Registration

export async function handleRegister(context: McpOAuthContext, request: Request) {
  if (!context.config.allowDynamicClientRegistration) {
    return oauthError(404, "invalid_request", "Dynamic client registration is disabled")
  }
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return oauthError(400, "invalid_client_metadata", "Send client metadata as JSON")
  }
  try {
    const client = await registerDynamicClient(context.store, body, context.now())
    return Response.json(
      {
        client_id: client.clientId,
        client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
        client_name: client.clientName,
        redirect_uris: client.redirectUris,
        grant_types: client.grantTypes,
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
      { status: 201, headers: noStore }
    )
  } catch (error) {
    if (error instanceof ClientRegistrationError) return oauthError(400, error.error, error.message)
    throw error
  }
}

// ---------------------------------------------------------------------------------------------
// Authorization endpoint

function authorizationErrorPage(status: number, message: string) {
  // The redirect URI could not be trusted, so the error is shown here instead of redirected.
  return new Response(`Quits could not start this connection: ${message}`, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", ...noStore },
  })
}

function redirectWithParams(redirectUri: string, params: Record<string, string | null | undefined>) {
  const url = new URL(redirectUri)
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined) url.searchParams.set(key, value)
  }
  return url.toString()
}

/**
 * Validates an authorization request and parks it for the consent page. The client and redirect
 * URI are checked before anything is redirected, so a bad request never sends the browser to an
 * unregistered address.
 */
export async function handleAuthorize(context: McpOAuthContext, request: Request) {
  const url = new URL(request.url)
  const params = url.searchParams
  const clientId = params.get("client_id")
  const redirectUri = params.get("redirect_uri")
  if (!clientId || !redirectUri) {
    return authorizationErrorPage(400, "client_id and redirect_uri are required")
  }

  let client: RegisteredClient
  try {
    client = await resolveClient(context, clientId, context.now())
  } catch (error) {
    if (error instanceof ClientRegistrationError) return authorizationErrorPage(400, error.message)
    throw error
  }
  if (!matchRedirectUri(redirectUri, client.redirectUris)) {
    return authorizationErrorPage(400, "redirect_uri is not registered for this client")
  }

  const state = params.get("state")
  const fail = (error: string, description: string) =>
    Response.redirect(
      redirectWithParams(redirectUri, { error, error_description: description, state, iss: context.config.issuer }),
      302
    )

  if (params.get("response_type") !== "code") {
    return fail("unsupported_response_type", "Only response_type=code is supported")
  }
  const codeChallenge = params.get("code_challenge")
  if (!codeChallenge || params.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) {
    return fail("invalid_request", "PKCE with code_challenge_method=S256 is required")
  }
  // MCP clients must name the server the token is for (RFC 8707). Tokens are only ever issued for
  // this server, so any other value is refused rather than ignored.
  const resource = params.get("resource")
  if (!sameResource(resource, context.config.resource)) {
    return fail("invalid_target", `resource must be ${context.config.resource}`)
  }
  const requested = parseScopeParameter(params.get("scope"))
  if (requested.unknown.length > 0) {
    return fail("invalid_scope", `Unknown or ungrantable scopes: ${requested.unknown.join(" ")}`)
  }

  const now = context.now()
  const id = randomBytes(24).toString("base64url")
  await context.store.savePendingAuthorization({
    id,
    clientId: client.clientId,
    redirectUri,
    state,
    codeChallenge,
    resource: context.config.resource,
    requestedScopes: requested.scopes,
    createdAt: now,
    expiresAt: new Date(now.getTime() + context.config.consentRequestTtlSeconds * 1000),
  })
  return Response.redirect(`${context.config.issuer}${CONSENT_PATH}?request=${encodeURIComponent(id)}`, 302)
}

// ---------------------------------------------------------------------------------------------
// Consent (called by the signed-in person through the app's own API)

async function loadPending(context: McpOAuthContext, requestId: string) {
  const pending = await context.store.getPendingAuthorization(requestId)
  if (!pending || pending.expiresAt <= context.now()) {
    throw new NotFound({ message: "This connection request has expired. Start again from your AI app.", entity: "oauthRequest" })
  }
  const client = await resolveClient(context, pending.clientId, context.now()).catch(() => {
    throw new NotFound({ message: "The app asking for access is no longer known", entity: "oauthClient" })
  })
  return { pending, client }
}

async function consentView(user: UserActor, pending: PendingAuthorization, client: RegisteredClient) {
  const organization = await prisma.organization.findUnique({
    where: { id: user.organizationId },
    select: { name: true },
  })
  return {
    requestId: pending.id,
    client: {
      name: client.clientName,
      uri: client.clientUri,
      id: client.clientId,
      registration: client.registration,
    },
    redirectHost: new URL(pending.redirectUri).host,
    loopbackRedirect: isLoopbackOnly([pending.redirectUri]),
    organizationName: organization?.name ?? "",
    canConnect: actorCan(user, "agent:create"),
    requestedScopes: pending.requestedScopes,
    suggestedPreset: suggestPreset(pending.requestedScopes, user.roles),
    presets: connectorPresets.map((preset) => ({
      id: preset.id,
      mode: preset.mode,
      scopes: presetScopesFor(preset, user.roles),
    })),
  }
}

function consentChanged() {
  return new ValidationFailed({ message: "The connection review changed. Start again from your AI app." })
}

function reviewDigest(view: Awaited<ReturnType<typeof consentView>>, pending: PendingAuthorization) {
  const { review: _review, ...request } = pending
  return hash(JSON.stringify({ view, request }))
}

/** Bind exactly what this signed-in session sees before it can decide. */
export async function describeConsentRequest(context: McpOAuthContext, user: UserActor, requestId: string, sessionId: string) {
  if (!sessionId) throw consentChanged()
  const { pending, client } = await loadPending(context, requestId)
  const view = await consentView(user, pending, client)
  const review = {
    id: randomBytes(24).toString("base64url"),
    userId: user.userId, sessionId, organizationId: user.organizationId,
    digest: reviewDigest(view, pending),
  }
  if (!(await context.store.bindConsentReview(requestId, review))) throw consentChanged()
  return { ...view, reviewId: review.id }
}

export type ConsentDecision =
  | { decision: "deny" }
  | { decision: "approve"; presetId: ConnectorPresetId; confirmFullAccess?: boolean }

/**
 * Records the person's decision and returns where to send the browser. Approving creates the
 * agent key the connection acts as; its scopes are the preset narrowed to the person's role.
 */
export async function decideConsent(
  context: McpOAuthContext,
  user: UserActor,
  requestId: string,
  input: ConsentDecision & { reviewId: string },
  sessionId: string
): Promise<{ redirectTo: string; agentKeyId: string | null }> {
  const { client, pending: reviewed } = await loadPending(context, requestId)
  const binding = reviewed.review
  if (!binding || !sessionId || binding.id !== input.reviewId || binding.userId !== user.userId ||
      binding.sessionId !== sessionId || binding.organizationId !== user.organizationId) throw consentChanged()
  const view = await consentView(user, reviewed, client)
  if (binding.digest !== reviewDigest(view, reviewed) || !matchRedirectUri(reviewed.redirectUri, client.redirectUris)) throw consentChanged()
  const pending = await context.store.takePendingAuthorization(requestId, input.reviewId)
  if (!pending) {
    throw new NotFound({ message: "This connection request was already answered", entity: "oauthRequest" })
  }
  const base = { state: pending.state, iss: context.config.issuer }

  if (input.decision === "deny") {
    return {
      redirectTo: redirectWithParams(pending.redirectUri, {
        ...base,
        error: "access_denied",
        error_description: "The person declined the connection",
      }),
      agentKeyId: null,
    }
  }

  if (!actorCan(user, "agent:create")) {
    throw new Forbidden({ message: "Connecting an AI app requires permission to create agent keys", permission: "agent:create" })
  }
  const preset = getConnectorPreset(input.presetId)
  if (!preset) {
    throw new ValidationFailed({ message: "Unknown access level" })
  }
  if (preset.mode === "full_access" && !input.confirmFullAccess) {
    throw new ValidationFailed({ message: "Confirm that this app may send documents and record payments without approval" })
  }
  const scopes = presetScopesFor(preset, user.roles)
  if (scopes.length === 0) {
    throw new Forbidden({ message: "Your role cannot grant any of this access level's permissions" })
  }

  const { key } = await createAgentKey(user, {
    name: client.clientName.slice(0, 80),
    mode: preset.mode,
    scopes,
    expiresInDays: null,
  })
  // The key's secret is never shown or used: the connection authenticates with OAuth tokens. The
  // prefix tells people in the agent key list that this key is a connection, and from which app.
  await prisma.agentKey.update({
    where: { id: key.id },
    data: { displayPrefix: `connector:${new URL(pending.redirectUri).host}`.slice(0, 64) },
  })

  const code = secret(CODE_PREFIX)
  const now = context.now()
  await context.store.saveCode({
    codeHash: hash(code),
    clientId: client.clientId,
    redirectUri: pending.redirectUri,
    codeChallenge: pending.codeChallenge,
    resource: pending.resource,
    agentKeyId: key.id,
    organizationId: user.organizationId,
    userId: user.userId,
    scopes,
    expiresAt: new Date(now.getTime() + context.config.authorizationCodeTtlSeconds * 1000),
    presetId: preset.id,
    usedAt: null,
    familyId: null,
  })
  return { redirectTo: redirectWithParams(pending.redirectUri, { ...base, code }), agentKeyId: key.id }
}

// ---------------------------------------------------------------------------------------------
// Token endpoint

/** Scopes the installation can still use: its grant intersected with its creator's current role. */
function effectiveScopes(actor: AgentActor, scopes: readonly Permission[]) {
  return scopes.filter((scope) => actorCan(actor, scope))
}

async function issueTokens(
  context: McpOAuthContext,
  client: RegisteredClient,
  family: TokenFamily,
  scopes: Permission[]
) {
  const now = context.now()
  const accessToken = secret(ACCESS_TOKEN_PREFIX)
  // Only clients that registered the refresh_token grant get refresh tokens.
  const refreshToken = client.grantTypes.includes("refresh_token") ? secret(REFRESH_TOKEN_PREFIX) : null
  await context.store.saveAccessToken({
    tokenHash: hash(accessToken),
    familyId: family.id,
    clientId: family.clientId,
    agentKeyId: family.agentKeyId,
    resource: family.resource,
    scopes,
    expiresAt: new Date(now.getTime() + context.config.accessTokenTtlSeconds * 1000),
  })
  if (refreshToken) {
    await context.store.saveRefreshToken({
      tokenHash: hash(refreshToken),
      familyId: family.id,
      expiresAt: new Date(now.getTime() + context.config.refreshTokenIdleTtlSeconds * 1000),
      rotatedAt: null,
    })
  }
  const current = await context.store.getFamily(family.id)
  if (!current || current.revokedAt) {
    return oauthError(400, "invalid_grant", "This connection was revoked")
  }
  return Response.json(
    {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: context.config.accessTokenTtlSeconds,
      ...(refreshToken ? { refresh_token: refreshToken } : {}),
      scope: formatScope(scopes),
    },
    { headers: noStore }
  )
}

async function liveInstallation(agentKeyId: string, now: Date) {
  try {
    return await resolveAgentActorById(agentKeyId, { allowRevoked: false, now })
  } catch {
    return null
  }
}

async function exchangeCode(context: McpOAuthContext, client: RegisteredClient, form: URLSearchParams) {
  const now = context.now()
  const code = form.get("code") ?? ""
  const clientId = form.get("client_id") ?? ""
  const verifier = form.get("code_verifier") ?? ""
  const stored = await context.store.getCode(hash(code))
  if (!stored || !sameString(stored.clientId, clientId)) {
    return oauthError(400, "invalid_grant", "The authorization code is invalid")
  }
  if (stored.usedAt) {
    // A replayed code may have been stolen: revoke everything issued with it.
    if (stored.familyId) await context.store.revokeFamily(stored.familyId, now)
    return oauthError(400, "invalid_grant", "The authorization code was already used")
  }
  if (stored.expiresAt <= now) {
    return oauthError(400, "invalid_grant", "The authorization code has expired")
  }
  if (form.get("redirect_uri") !== stored.redirectUri) {
    return oauthError(400, "invalid_grant", "redirect_uri does not match the authorization request")
  }
  if (form.has("resource") && !sameResource(form.get("resource"), stored.resource)) {
    return oauthError(400, "invalid_target", "resource does not match the authorization request")
  }
  if (!CODE_VERIFIER.test(verifier) || !sameString(createHash("sha256").update(verifier).digest("base64url"), stored.codeChallenge)) {
    return oauthError(400, "invalid_grant", "PKCE verification failed")
  }

  const familyId = randomUUID()
  const family: TokenFamily = {
    id: familyId,
    clientId: stored.clientId,
    agentKeyId: stored.agentKeyId,
    organizationId: stored.organizationId,
    userId: stored.userId,
    resource: stored.resource,
    scopes: stored.scopes,
    presetId: stored.presetId,
    createdAt: now,
    revokedAt: null,
  }
  if (!(await context.store.consumeCode(hash(code), now, family))) {
    return oauthError(400, "invalid_grant", "The authorization code was already used")
  }
  const actor = await liveInstallation(stored.agentKeyId, now)
  if (!actor) {
    await context.store.revokeFamily(family.id, now)
    return oauthError(400, "invalid_grant", "This connection was revoked or its owner no longer has access")
  }
  return issueTokens(context, client, family, effectiveScopes(actor, stored.scopes))
}

async function refresh(context: McpOAuthContext, client: RegisteredClient, form: URLSearchParams) {
  const now = context.now()
  const tokenHash = hash(form.get("refresh_token") ?? "")
  const stored = await context.store.getRefreshToken(tokenHash)
  const family = stored ? await context.store.getFamily(stored.familyId) : null
  if (!stored || !family || !sameString(family.clientId, form.get("client_id") ?? "")) {
    return oauthError(400, "invalid_grant", "The refresh token is invalid")
  }
  if (stored.rotatedAt) {
    // Refresh tokens are single use. A second use means two parties hold it: end the connection.
    await context.store.revokeFamily(family.id, now)
    return oauthError(400, "invalid_grant", "The refresh token was already used")
  }
  if (family.revokedAt || stored.expiresAt <= now) {
    return oauthError(400, "invalid_grant", "The refresh token has expired or was revoked")
  }
  if (form.has("resource") && !sameResource(form.get("resource"), family.resource)) {
    return oauthError(400, "invalid_target", "resource does not match this connection")
  }
  const requested = parseScopeParameter(form.get("scope"))
  if (requested.unknown.length > 0 || requested.scopes.some((scope) => !family.scopes.includes(scope))) {
    return oauthError(400, "invalid_scope", "A refresh can only narrow the granted scopes")
  }
  const actor = await liveInstallation(family.agentKeyId, now)
  if (!actor) {
    await context.store.revokeFamily(family.id, now)
    return oauthError(400, "invalid_grant", "This connection was revoked or its owner no longer has access")
  }
  if (!(await context.store.markRefreshTokenRotated(tokenHash, now))) {
    await context.store.revokeFamily(family.id, now)
    return oauthError(400, "invalid_grant", "The refresh token was already used")
  }
  const scopes = requested.scopes.length > 0 ? requested.scopes : family.scopes
  return issueTokens(context, client, family, effectiveScopes(actor, scopes))
}

async function readForm(request: Request) {
  const type = request.headers.get("content-type") ?? ""
  if (!type.toLowerCase().startsWith("application/x-www-form-urlencoded")) return null
  return new URLSearchParams(await request.text())
}

export async function handleToken(context: McpOAuthContext, request: Request) {
  const form = await readForm(request)
  if (!form) {
    return oauthError(400, "invalid_request", "Send the token request as application/x-www-form-urlencoded")
  }
  if (request.headers.has("authorization")) {
    return oauthError(401, "invalid_client", "Only public clients are supported; do not send client credentials")
  }
  const clientId = form.get("client_id")
  if (!clientId) {
    return oauthError(401, "invalid_client", "client_id is required")
  }
  let client: RegisteredClient
  try {
    client = await resolveClient(context, clientId, context.now())
  } catch (error) {
    if (error instanceof ClientRegistrationError) return oauthError(401, "invalid_client", error.message)
    throw error
  }
  const grantType = form.get("grant_type")
  if (grantType && !client.grantTypes.includes(grantType)) {
    return oauthError(400, "unauthorized_client", `This client did not register the ${grantType} grant`)
  }
  switch (grantType) {
    case "authorization_code":
      return exchangeCode(context, client, form)
    case "refresh_token":
      return refresh(context, client, form)
    default:
      return oauthError(400, "unsupported_grant_type", "Use authorization_code or refresh_token")
  }
}

/** RFC 7009 disconnects this installation, including pending approvals. */
export async function handleRevoke(context: McpOAuthContext, request: Request) {
  const form = await readForm(request)
  if (!form) return oauthError(400, "invalid_request", "Send the request as application/x-www-form-urlencoded")
  const tokenHash = hash(form.get("token") ?? "")
  const clientId = form.get("client_id") ?? ""
  const refreshToken = await context.store.getRefreshToken(tokenHash)
  const accessToken = refreshToken ? null : await context.store.getAccessToken(tokenHash)
  const familyId = refreshToken?.familyId ?? accessToken?.familyId
  const family = familyId ? await context.store.getFamily(familyId) : null
  if (family && sameString(family.clientId, clientId)) {
    const now = context.now()
    await context.store.revokeFamily(family.id, now)
    await disconnectInstallation(family, now)
  }
  // Unknown tokens are not an error (RFC 7009 section 2.2).
  return new Response(null, { status: 200, headers: noStore })
}

// ---------------------------------------------------------------------------------------------
// Resource server

export function isMcpAccessToken(token: string) {
  return token.startsWith(ACCESS_TOKEN_PREFIX)
}

export type AuthenticatedGrant = { actor: AgentActor; scopes: Permission[]; clientId: string }

/**
 * Authenticates an access token for the MCP endpoint, or returns null (answer `401`). The token
 * must be unexpired, unrevoked and issued for this server. The actor is the installation's agent
 * actor as of now, narrowed to the token's scopes, so revocation, membership removal and role
 * changes take effect on the next call whatever tokens the client still holds.
 */
export async function authenticateMcpAccessToken(
  context: McpOAuthContext,
  token: string
): Promise<AuthenticatedGrant | null> {
  const now = context.now()
  let grant: { agentKeyId: string; scopes: string[]; clientId: string; resource: string } | null = null
  if (isMcpAccessToken(token)) {
    const stored = await context.store.getAccessToken(hash(token))
    const family = stored ? await context.store.getFamily(stored.familyId) : null
    if (stored && family && !family.revokedAt && stored.expiresAt > now) {
      grant = stored
    }
  } else {
    grant = await runAccessTokenVerifiers(token, { resource: context.config.resource, now })
  }
  if (!grant || !sameResource(grant.resource, context.config.resource)) {
    return null
  }
  const installation = await liveInstallation(grant.agentKeyId, now)
  if (!installation) {
    return null
  }
  const scopes = installation.scopes.filter((scope) => grant.scopes.includes(scope))
  return { actor: { ...installation, scopes }, scopes, clientId: grant.clientId }
}

/** Connections listed with an agent key, for the settings page. */
export async function connectionsForAgentKeys(context: McpOAuthContext, agentKeyIds: readonly string[]) {
  const families = await context.store.listFamiliesForAgentKeys(agentKeyIds)
  return families.map((family) => ({
    agentKeyId: family.agentKeyId,
    clientId: family.clientId,
    presetId: family.presetId,
    createdAt: family.createdAt,
    revokedAt: family.revokedAt,
  }))
}
