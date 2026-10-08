import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../../lib/email", async () => {
  const actual = await vi.importActual<typeof import("../../../lib/email")>("../../../lib/email")
  return { ...actual, deliver: vi.fn().mockResolvedValue({ id: "email_123" }) }
})

import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { prisma } from "../../../lib/db"
import { createTestOrganization, hasTestDatabase } from "../../../test-utils/organization"
import { ensureTestMembership } from "../../../test-utils/membership"
import { appRouter } from "../../../trpc/router"
import { createAgentKey, revokeAgentKey } from "../../agent-keys"
import type { UserActor } from "../../actor"
import { resolveUserActor } from "../../user-actor"
import { setMcpAccessTokenVerifiers } from "../extension"
import { describeConsentRequest, setMcpOAuthContext, type ConsentDecision } from "../server"
import { chatGptClientMetadata, claudeCodeClientMetadata } from "./fixtures"
import {
  ISSUER,
  MCP_URL,
  MemoryOAuthProvider,
  appFetch,
  authorizeInBrowser,
  initializeParams,
  parseChallenge,
  pkcePair,
  rawMcp,
  rawToolCall,
  testOAuthContext,
  tokenRequest,
} from "./harness"

const describeIfDatabase = hasTestDatabase ? describe : describe.skip

type Org = Awaited<ReturnType<typeof createTestOrganization>>
type Tokens = { access_token: string; refresh_token: string; scope: string; expires_in: number }

const CHATGPT_REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect"
const approve = (presetId: Extract<ConsentDecision, { decision: "approve" }>["presetId"]): ConsentDecision => ({
  decision: "approve",
  presetId,
  confirmFullAccess: presetId === "full_access",
})

function callerFor(org: Org, role: "admin" | "member" | "accountant") {
  const userId = org.actors[role].userId
  return appRouter.createCaller({
    session: {
      user: { id: userId, email: `${userId}@test.quits.invalid`, name: userId },
      session: { id: "integration-session", activeOrganizationId: org.organizationId },
    },
  } as never)
}

/**
 * A ChatGPT-style connection, written against the specs with raw HTTP instead of the MCP SDK:
 * discovery from the 401, metadata validation, a Client ID Metadata Document client_id, PKCE,
 * `resource`, and RFC 9207 `iss` checking on the redirect.
 */
async function connectLikeChatGpt(
  context: ReturnType<typeof testOAuthContext>,
  user: UserActor,
  decision: ConsentDecision
): Promise<Tokens> {
  const unauthenticated = await rawMcp(null, "initialize", initializeParams)
  expect(unauthenticated.response.status).toBe(401)
  const challenge = parseChallenge(unauthenticated.response.headers.get("www-authenticate"))

  const resourceMetadata = await (await appFetch(challenge.resource_metadata!)).json()
  expect(resourceMetadata.resource).toBe(MCP_URL)
  const issuer = resourceMetadata.authorization_servers[0] as string
  const serverMetadata = await (await appFetch(`${issuer}/.well-known/oauth-authorization-server`)).json()
  expect(serverMetadata).toMatchObject({
    issuer,
    code_challenge_methods_supported: ["S256"],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  })
  expect(serverMetadata.token_endpoint_auth_methods_supported).toContain("none")

  const { verifier, challenge: codeChallenge } = pkcePair()
  const authorize = new URL(serverMetadata.authorization_endpoint)
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: chatGptClientMetadata.client_id,
    redirect_uri: CHATGPT_REDIRECT,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state: "chatgpt-state",
    scope: challenge.scope!,
    resource: resourceMetadata.resource,
  }).toString()
  const callback = await authorizeInBrowser(context, authorize, user, decision)
  expect(`${callback.origin}${callback.pathname}`).toBe(CHATGPT_REDIRECT)
  expect(callback.searchParams.get("iss")).toBe(issuer)
  expect(callback.searchParams.get("state")).toBe("chatgpt-state")

  const response = await tokenRequest({
    grant_type: "authorization_code",
    code: callback.searchParams.get("code")!,
    redirect_uri: CHATGPT_REDIRECT,
    client_id: chatGptClientMetadata.client_id,
    code_verifier: verifier,
    resource: resourceMetadata.resource,
  })
  expect(response.status).toBe(200)
  expect(response.headers.get("cache-control")).toBe("no-store")
  return response.json()
}

function refreshTokens(tokens: Tokens, extra: Record<string, string> = {}) {
  return tokenRequest({
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token,
    client_id: chatGptClientMetadata.client_id,
    ...extra,
  })
}

async function draftInvoice(token: string, prefix: string) {
  const contact = await rawToolCall(token, "contact_create", {
    name: "Acme",
    email: "billing@acme.test",
    clientRequestId: `${prefix}-contact`,
  })
  expect(contact.value).toMatchObject({ status: "completed" })
  const draft = await rawToolCall(token, "invoice_create_draft", {
    contactId: contact.value.result.id,
    dueDate: "2099-12-01",
    supplyDate: "2099-12-01",
    taxRate: "25",
    items: [{ description: "Design", quantity: "2", unitPrice: "100" }],
    clientRequestId: `${prefix}-draft`,
  })
  expect(draft.value).toMatchObject({ status: "completed", result: { status: "draft" } })
  return draft.value.result.id as string
}

describeIfDatabase("MCP sign-in authorization prototype", () => {
  const cleanups: Array<() => Promise<void>> = []
  let context: ReturnType<typeof testOAuthContext>

  beforeEach(() => {
    context = testOAuthContext()
    setMcpOAuthContext(context)
  })

  afterEach(async () => {
    setMcpOAuthContext(undefined)
    setMcpAccessTokenVerifiers([])
    while (cleanups.length) await cleanups.pop()?.()
  })

  async function setup(roles: Array<"admin" | "member" | "accountant"> = ["admin"]) {
    const org = await createTestOrganization({ roles })
    cleanups.push(org.cleanup)
    return org
  }

  describe("discovery", () => {
    it("points unauthenticated clients at protected resource and authorization server metadata", async () => {
      const { response } = await rawMcp(null, "initialize", initializeParams)
      expect(response.status).toBe(401)
      const challenge = parseChallenge(response.headers.get("www-authenticate"))
      expect(challenge.resource_metadata).toBe(`${ISSUER}/.well-known/oauth-protected-resource/api/mcp`)
      expect(challenge.scope).toContain("invoice:read")
      expect(challenge.scope).not.toContain("invoice:send")

      const root = await (await appFetch(`${ISSUER}/.well-known/oauth-protected-resource`)).json()
      expect(root).toMatchObject({ resource: MCP_URL, authorization_servers: [ISSUER] })
      expect(root.scopes_supported).not.toContain("offline_access")

      const metadata = await (await appFetch(`${ISSUER}/.well-known/oauth-authorization-server`)).json()
      expect(metadata.registration_endpoint).toBe(`${ISSUER}/api/mcp/oauth/register`)
      expect(metadata.grant_types_supported).toEqual(["authorization_code", "refresh_token"])
    })

    it("serves nothing and accepts only agent keys while the prototype is off", async () => {
      setMcpOAuthContext(null)
      expect((await appFetch(`${ISSUER}/.well-known/oauth-authorization-server`)).status).toBe(404)
      expect((await appFetch(`${ISSUER}/api/mcp/oauth/authorize?client_id=x`)).status).toBe(404)
      const { response, body } = await rawMcp("quits_at_whatever", "initialize", initializeParams)
      expect(response.status).toBe(401)
      expect(response.headers.get("www-authenticate")).toBe('Bearer realm="quits", error="invalid_token"')
      expect(body.error.message).toBe("Invalid agent key")
    })
  })

  describe("authenticated consent binding", () => {
    it("rejects another active organization in the same real user's session, then grants only the reviewed organization", async () => {
      const orgA = await setup()
      const orgB = await setup()
      const owner = orgA.actors.admin
      await ensureTestMembership(orgB.organizationId, owner.userId, "admin")
      const authorize = new URL(`${ISSUER}/api/mcp/oauth/authorize`)
      authorize.search = new URLSearchParams({ response_type: "code", client_id: chatGptClientMetadata.client_id,
        redirect_uri: CHATGPT_REDIRECT, code_challenge: pkcePair().challenge, code_challenge_method: "S256", resource: MCP_URL }).toString()
      const location = (await appFetch(authorize)).headers.get("location")!
      const requestId = new URL(location).searchParams.get("request")!
      const session = { user: { id: owner.userId, email: "admin@test.quits.invalid", name: "Admin" },
        session: { id: "browser-session", activeOrganizationId: orgA.organizationId } }
      const caller = appRouter.createCaller({ session } as never)
      const review = await caller.connectors.consentRequest({ requestId })
      expect(review.organizationName).toContain(orgA.organizationId.slice(0, 8))
      session.session.activeOrganizationId = orgB.organizationId
      await expect(caller.connectors.decide({ requestId, reviewId: review.reviewId, ...approve("read_only") })).rejects.toThrow("review changed")
      await expect(caller.connectors.consentRequest({ requestId })).rejects.toThrow("review changed")
      expect(await prisma.agentKey.count({ where: { organizationId: { in: [orgA.organizationId, orgB.organizationId] } } })).toBe(0)
      session.session.activeOrganizationId = orgA.organizationId
      const result = await caller.connectors.decide({ requestId, reviewId: review.reviewId, ...approve("read_only") })
      expect(new URL(result.redirectTo).searchParams.has("code")).toBe(true)
      const keys = await prisma.agentKey.findMany({ where: { createdByUserId: owner.userId } })
      expect(keys).toHaveLength(1)
      expect(keys[0]?.organizationId).toBe(orgA.organizationId)
    })
  })

  describe("local proof of connection", () => {
    it("connects a Claude Code-style client (MCP SDK, metadata document, loopback redirect)", async () => {
      const org = await setup()
      const port = 40000 + Math.floor(Math.random() * 20000)
      const provider = new MemoryOAuthProvider({
        redirectUrl: `http://localhost:${port}/callback`,
        clientName: "Claude Code",
        clientMetadataUrl: claudeCodeClientMetadata.client_id,
      })
      const transport = () => new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: provider, fetch: appFetch })

      const first = new Client({ name: "claude-code-profile", version: "1.0.0" })
      await expect(first.connect(transport())).rejects.toBeInstanceOf(UnauthorizedError)
      const authorizationUrl = provider.authorizationUrl!
      expect(authorizationUrl.searchParams.get("client_id")).toBe(claudeCodeClientMetadata.client_id)
      expect(authorizationUrl.searchParams.get("resource")).toBe(MCP_URL)
      expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256")

      const consentUrl = new URL((await appFetch(new Request(authorizationUrl))).headers.get("location")!)
      const consent = await describeConsentRequest(context, org.actors.admin, consentUrl.searchParams.get("request")!, "harness-session")
      expect(consent).toMatchObject({
        client: { name: "Claude Code", registration: "metadata_document" },
        redirectHost: `localhost:${port}`,
        loopbackRedirect: true,
        suggestedPreset: "read_only",
        canConnect: true,
      })

      const callback = await authorizeInBrowser(context, authorizationUrl, org.actors.admin, approve("drafting_only"))
      expect(callback.host).toBe(`localhost:${port}`)
      expect(callback.searchParams.get("state")).toBe(provider.expectedState)
      expect(callback.searchParams.get("iss")).toBe(ISSUER)
      const finishing = transport()
      await finishing.finishAuth(callback.searchParams.get("code")!)
      expect(provider.tokens()?.access_token).toMatch(/^quits_at_/)

      const client = new Client({ name: "claude-code-profile", version: "1.0.0" })
      await client.connect(transport())
      const names = (await client.listTools()).tools.map((tool) => tool.name)
      expect(names).toEqual(expect.arrayContaining(["invoice_create_draft", "contact_create"]))
      expect(names).not.toContain("invoice_send")
      const result = (await client.callTool({ name: "organization_read" })) as CallToolResult
      const content = result.content[0]
      expect(content?.type === "text" && JSON.parse(content.text).agent).toMatchObject({ mode: "approval_required" })

      // The connection is an agent key the organization can see and revoke.
      const keys = await callerFor(org, "admin").agents.listKeys()
      expect(keys).toEqual([expect.objectContaining({ name: "Claude Code", displayPrefix: `connector:localhost:${port}` })])
    })

    it("connects a client that registers dynamically (MCP SDK, RFC 7591)", async () => {
      const org = await setup()
      const provider = new MemoryOAuthProvider({ redirectUrl: "http://127.0.0.1:53682/callback", clientName: "Local MCP client" })
      const transport = () => new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: provider, fetch: appFetch })
      await expect(new Client({ name: "dcr", version: "1" }).connect(transport())).rejects.toBeInstanceOf(UnauthorizedError)
      expect(provider.clientInformation()?.client_id).toMatch(/^quits_dcr_/)

      const callback = await authorizeInBrowser(context, provider.authorizationUrl!, org.actors.admin, approve("read_only"))
      await transport().finishAuth(callback.searchParams.get("code")!)
      const client = new Client({ name: "dcr", version: "1" })
      await client.connect(transport())
      const names = (await client.listTools()).tools.map((tool) => tool.name)
      expect(names).toContain("invoices_list")
      expect(names).not.toContain("contact_create")
    })

    it("connects a ChatGPT-style client (raw HTTP, metadata document, https redirect with iss)", async () => {
      const org = await setup()
      const tokens = await connectLikeChatGpt(context, org.actors.admin, approve("drafting_with_approved_sending"))
      expect(tokens.scope.split(" ")).toContain("invoice:send")
      const { response, body } = await rawMcp(tokens.access_token, "initialize", initializeParams)
      expect(response.status).toBe(200)
      expect(body.result.serverInfo.name).toBe("quits")
    })

    it("sends the browser back with access_denied when the person declines", async () => {
      const org = await setup()
      const { challenge } = pkcePair()
      const url = new URL(`${ISSUER}/api/mcp/oauth/authorize`)
      url.search = new URLSearchParams({
        response_type: "code",
        client_id: chatGptClientMetadata.client_id,
        redirect_uri: CHATGPT_REDIRECT,
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: "s1",
        resource: MCP_URL,
      }).toString()
      const callback = await authorizeInBrowser(context, url, org.actors.admin, { decision: "deny" })
      expect(callback.searchParams.get("error")).toBe("access_denied")
      expect(callback.searchParams.get("code")).toBeNull()
      expect(await prisma.agentKey.count({ where: { organizationId: org.organizationId } })).toBe(0)
    })

    it("requires an explicit confirmation for full access and permission to create agent keys", async () => {
      const org = await setup(["admin", "member"])
      const { challenge } = pkcePair()
      const start = async () => {
        const url = new URL(`${ISSUER}/api/mcp/oauth/authorize`)
        url.search = new URLSearchParams({
          response_type: "code",
          client_id: chatGptClientMetadata.client_id,
          redirect_uri: CHATGPT_REDIRECT,
          code_challenge: challenge,
          code_challenge_method: "S256",
          resource: MCP_URL,
        }).toString()
        return url
      }
      await expect(
        authorizeInBrowser(context, await start(), org.actors.admin, { decision: "approve", presetId: "full_access" })
      ).rejects.toThrow("Confirm")
      await expect(
        authorizeInBrowser(context, await start(), org.actors.member, approve("drafting_only"))
      ).rejects.toThrow("permission to create agent keys")
    })
  })

  describe("scope and approval enforcement", () => {
    it("lets a draft-only grant draft but refuses send for insufficient scope, with no approval queued", async () => {
      const org = await setup()
      const tokens = await connectLikeChatGpt(context, org.actors.admin, approve("drafting_only"))
      expect(tokens.scope.split(" ")).not.toContain("invoice:send")
      const invoiceId = await draftInvoice(tokens.access_token, "draft-only")

      const send = await rawToolCall(tokens.access_token, "invoice_send", {
        id: invoiceId,
        allowSendWithoutEmail: true,
        clientRequestId: "send-1",
      })
      expect(send.status).toBe(403)
      const challenge = parseChallenge(send.response.headers.get("www-authenticate"))
      expect(challenge).toMatchObject({ error: "insufficient_scope", scope: "invoice:send" })
      expect(await prisma.approvalRequest.count({ where: { organizationId: org.organizationId } })).toBe(0)
      expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).status).toBe("draft")

      // Asking for the scope on refresh cannot add it: a refresh only narrows.
      const widened = await refreshTokens(tokens, { scope: "invoice:read invoice:send" })
      expect(widened.status).toBe(400)
      expect((await widened.json()).error).toBe("invalid_scope")
    })

    it("queues send from an approval-mode grant and keeps the stale-review check", async () => {
      const org = await setup()
      const tokens = await connectLikeChatGpt(context, org.actors.admin, approve("drafting_with_approved_sending"))
      const invoiceId = await draftInvoice(tokens.access_token, "approval")

      const queued = await rawToolCall(tokens.access_token, "invoice_send", {
        id: invoiceId,
        allowSendWithoutEmail: true,
        clientRequestId: "send-1",
      })
      expect(queued.value).toMatchObject({ status: "awaiting_approval" })
      const [pending] = await callerFor(org, "admin").agents.approvals({ view: "pending" })
      expect(pending).toMatchObject({ commandType: "invoice.send", agent: { name: "ChatGPT" } })

      // The agent edits the draft after asking: approving what was reviewed must not send it.
      await rawToolCall(tokens.access_token, "invoice_update_draft", {
        id: invoiceId,
        items: [{ description: "Design", quantity: "3", unitPrice: "100" }],
        clientRequestId: "edit-1",
      })
      const decided = await callerFor(org, "admin").agents.decide({
        approvalRequestId: queued.value.approvalRequestId,
        decision: "approve",
      })
      expect(decided).toMatchObject({ status: "failed", error: { code: "changed_since_review" } })
      expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).status).toBe("draft")

      // Asked again, approval sends it.
      const again = await rawToolCall(tokens.access_token, "invoice_send", {
        id: invoiceId,
        allowSendWithoutEmail: true,
        clientRequestId: "send-2",
      })
      const approved = await callerFor(org, "admin").agents.decide({
        approvalRequestId: again.value.approvalRequestId,
        decision: "approve",
      })
      expect(approved).toMatchObject({ status: "completed" })
      expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).status).toBe("sent")
    })

    it("cannot use approval to supply a permission the owner lost", async () => {
      const org = await setup(["admin", "member"])
      // The member's own connection: members may send, so promote them to connect, then demote.
      await prisma.member.update({ where: { id: `${org.organizationId}:${org.actors.member.userId}` }, data: { role: "admin" } })
      const owner = (await resolveUserActor({ organizationId: org.organizationId, userId: org.actors.member.userId }))!
      const tokens = await connectLikeChatGpt(context, owner, approve("drafting_with_approved_sending"))
      const invoiceId = await draftInvoice(tokens.access_token, "lost")
      const queued = await rawToolCall(tokens.access_token, "invoice_send", {
        id: invoiceId,
        allowSendWithoutEmail: true,
        clientRequestId: "send-1",
      })
      expect(queued.value.status).toBe("awaiting_approval")

      await prisma.member.update({ where: { id: `${org.organizationId}:${owner.userId}` }, data: { role: "accountant" } })
      const decided = await callerFor(org, "admin").agents.decide({
        approvalRequestId: queued.value.approvalRequestId,
        decision: "approve",
      })
      expect(decided).toMatchObject({ status: "failed", error: { tag: "Forbidden" } })
      expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).status).toBe("draft")
    })
  })

  describe("revocation, membership and role changes", () => {
    it("revoking the connection blocks calls and refresh and expires its pending approvals", async () => {
      const org = await setup()
      const tokens = await connectLikeChatGpt(context, org.actors.admin, approve("drafting_with_approved_sending"))
      const invoiceId = await draftInvoice(tokens.access_token, "revoke")
      const queued = await rawToolCall(tokens.access_token, "invoice_send", {
        id: invoiceId,
        allowSendWithoutEmail: true,
        clientRequestId: "send-1",
      })
      const [key] = await callerFor(org, "admin").agents.listKeys()
      await revokeAgentKey(org.actors.admin, key!.id)

      const call = await rawMcp(tokens.access_token, "initialize", initializeParams)
      expect(call.response.status).toBe(401)
      expect(parseChallenge(call.response.headers.get("www-authenticate")).error).toBe("invalid_token")
      const refreshed = await refreshTokens(tokens)
      expect(refreshed.status).toBe(400)
      expect((await refreshed.json()).error).toBe("invalid_grant")
      const approval = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: queued.value.approvalRequestId } })
      expect(approval.status).toBe("expired")
    })

    it.each(["access_token", "refresh_token"] as const)("client revocation of %s disconnects only its installation and expires pending work", async (tokenKind) => {
      const org = await setup()
      const tokens = await connectLikeChatGpt(context, org.actors.admin, approve("drafting_with_approved_sending"))
      const invoiceId = await draftInvoice(tokens.access_token, "disconnect")
      const queued = await rawToolCall(tokens.access_token, "invoice_send", {
        id: invoiceId, allowSendWithoutEmail: true, clientRequestId: "pending-disconnect",
      })
      const other = await connectLikeChatGpt(context, org.actors.admin, approve("read_only"))
      const revoke = (clientId = chatGptClientMetadata.client_id) => appFetch(`${ISSUER}/api/mcp/oauth/revoke`, {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: clientId, token: tokens[tokenKind] }).toString(),
      })
      expect((await revoke(claudeCodeClientMetadata.client_id)).status).toBe(200)
      expect((await rawMcp(tokens.access_token, "initialize", initializeParams)).response.status).toBe(200)
      expect((await revoke()).status).toBe(200)
      expect((await revoke()).status).toBe(200)
      expect((await rawMcp(tokens.access_token, "initialize", initializeParams)).response.status).toBe(401)
      expect((await refreshTokens(tokens)).status).toBe(400)
      expect((await rawMcp(other.access_token, "initialize", initializeParams)).response.status).toBe(200)
      const pending = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: queued.value.approvalRequestId } })
      expect(pending.status).toBe("expired")
      const key = await prisma.agentKey.findUniqueOrThrow({ where: { id: pending.agentKeyId } })
      expect(key.revokedAt).not.toBeNull()
      await callerFor(org, "admin").agents.decide({ approvalRequestId: pending.id, decision: "approve" }).catch(() => {})
      expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).status).toBe("draft")
    })

    it("removing the owner from the organization blocks calls, refresh and pending work", async () => {
      const org = await setup(["admin", "member"])
      await prisma.member.update({ where: { id: `${org.organizationId}:${org.actors.member.userId}` }, data: { role: "admin" } })
      const owner = (await resolveUserActor({ organizationId: org.organizationId, userId: org.actors.member.userId }))!
      const tokens = await connectLikeChatGpt(context, owner, approve("drafting_with_approved_sending"))
      const invoiceId = await draftInvoice(tokens.access_token, "removed")
      const queued = await rawToolCall(tokens.access_token, "invoice_send", {
        id: invoiceId,
        allowSendWithoutEmail: true,
        clientRequestId: "send-1",
      })

      await prisma.member.delete({ where: { id: `${org.organizationId}:${owner.userId}` } })
      expect((await rawMcp(tokens.access_token, "initialize", initializeParams)).response.status).toBe(401)
      expect((await refreshTokens(tokens)).status).toBe(400)
      const decided = await callerFor(org, "admin").agents.decide({
        approvalRequestId: queued.value.approvalRequestId,
        decision: "approve",
      })
      expect(decided).toMatchObject({ status: "failed", error: { tag: "Forbidden" } })
      expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).status).toBe("draft")
    })

    it("role demotion takes effect on live tokens and refresh cannot restore it", async () => {
      const org = await setup(["admin", "member"])
      await prisma.member.update({ where: { id: `${org.organizationId}:${org.actors.member.userId}` }, data: { role: "admin" } })
      const owner = (await resolveUserActor({ organizationId: org.organizationId, userId: org.actors.member.userId }))!
      const tokens = await connectLikeChatGpt(context, owner, approve("drafting_only"))
      await draftInvoice(tokens.access_token, "demote")

      await prisma.member.update({ where: { id: `${org.organizationId}:${owner.userId}` }, data: { role: "accountant" } })
      const create = await rawToolCall(tokens.access_token, "contact_create", { name: "Late", clientRequestId: "late-1" })
      expect(create.isError).toBe(true)
      expect(create.value).toEqual(expect.stringContaining("not found"))

      const refreshed = await refreshTokens(tokens)
      expect(refreshed.status).toBe(200)
      const narrowed = (await refreshed.json()) as Tokens
      expect(narrowed.scope.split(" ")).not.toContain("contact:create")
      expect(narrowed.scope.split(" ")).toContain("invoice:read")
      const retry = await rawToolCall(narrowed.access_token, "contact_create", { name: "Late", clientRequestId: "late-2" })
      expect(retry.isError).toBe(true)
      expect(await prisma.contact.count({ where: { organizationId: org.organizationId, name: "Late" } })).toBe(0)
    })
  })

  describe("isolation and token handling", () => {
    it("refuses unregistered redirects without redirecting, and other resources", async () => {
      const org = await setup()
      const { challenge } = pkcePair()
      const authorize = (params: Record<string, string>) => {
        const url = new URL(`${ISSUER}/api/mcp/oauth/authorize`)
        url.search = new URLSearchParams({
          response_type: "code",
          client_id: chatGptClientMetadata.client_id,
          redirect_uri: CHATGPT_REDIRECT,
          code_challenge: challenge,
          code_challenge_method: "S256",
          resource: MCP_URL,
          state: "s",
          ...params,
        }).toString()
        return appFetch(url)
      }
      for (const redirect_uri of [
        "https://evil.example/callback",
        "https://chatgpt.com/connector_platform_oauth_redirect/../evil",
        "http://localhost:8080/callback",
      ]) {
        const response = await authorize({ redirect_uri })
        expect(response.status).toBe(400)
        expect(response.headers.get("location")).toBeNull()
      }

      const foreign = await authorize({ resource: "https://other.example/api/mcp" })
      const location = new URL(foreign.headers.get("location")!)
      expect(`${location.origin}${location.pathname}`).toBe(CHATGPT_REDIRECT)
      expect(location.searchParams.get("error")).toBe("invalid_target")

      const plain = await authorize({ code_challenge_method: "plain" })
      expect(new URL(plain.headers.get("location")!).searchParams.get("error")).toBe("invalid_request")
      const ungrantable = await authorize({ scope: "agent:create" })
      expect(new URL(ungrantable.headers.get("location")!).searchParams.get("error")).toBe("invalid_scope")
      expect(await prisma.agentKey.count({ where: { organizationId: org.organizationId } })).toBe(0)
    })

    it("only accepts tokens issued for this server", async () => {
      const org = await setup()
      const tokens = await connectLikeChatGpt(context, org.actors.admin, approve("read_only"))
      // Same grant store, but this server is another resource: the token's audience is wrong.
      setMcpOAuthContext({ ...context, config: { ...context.config, resource: "https://other.test/api/mcp" } })
      expect((await rawMcp(tokens.access_token, "initialize", initializeParams)).response.status).toBe(401)

      setMcpOAuthContext(context)
      expect((await rawMcp(tokens.access_token, "initialize", initializeParams)).response.status).toBe(200)
      // Refresh tokens and codes are not access tokens.
      expect((await rawMcp(tokens.refresh_token, "initialize", initializeParams)).response.status).toBe(401)
    })

    it("expires access tokens, rotates refresh tokens and revokes on refresh-token reuse", async () => {
      const org = await setup()
      const tokens = await connectLikeChatGpt(context, org.actors.admin, approve("read_only"))
      context.clock.now = new Date(context.clock.now.getTime() + 16 * 60 * 1000)
      expect((await rawMcp(tokens.access_token, "initialize", initializeParams)).response.status).toBe(401)

      const rotated = (await (await refreshTokens(tokens)).json()) as Tokens
      expect(rotated.refresh_token).not.toBe(tokens.refresh_token)
      expect((await rawMcp(rotated.access_token, "initialize", initializeParams)).response.status).toBe(200)

      const replay = await refreshTokens(tokens)
      expect((await replay.json()).error).toBe("invalid_grant")
      // The replay ended the whole connection, including the legitimate rotated tokens.
      expect((await rawMcp(rotated.access_token, "initialize", initializeParams)).response.status).toBe(401)
      expect((await refreshTokens(rotated)).status).toBe(400)
    })

    it("gives refresh tokens only to clients that registered the refresh_token grant", async () => {
      const org = await setup()
      const registered = await appFetch(`${ISSUER}/api/mcp/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_name: "No refresh", redirect_uris: ["http://127.0.0.1/cb"], token_endpoint_auth_method: "none" }),
      })
      expect(registered.status).toBe(201)
      const { client_id } = await registered.json()
      const { verifier, challenge } = pkcePair()
      const url = new URL(`${ISSUER}/api/mcp/oauth/authorize`)
      url.search = new URLSearchParams({
        response_type: "code",
        client_id,
        redirect_uri: "http://127.0.0.1:9911/cb",
        code_challenge: challenge,
        code_challenge_method: "S256",
        resource: MCP_URL,
      }).toString()
      const callback = await authorizeInBrowser(context, url, org.actors.admin, approve("read_only"))
      const response = await tokenRequest({
        grant_type: "authorization_code",
        code: callback.searchParams.get("code")!,
        redirect_uri: "http://127.0.0.1:9911/cb",
        client_id,
        code_verifier: verifier,
      })
      const tokens = await response.json()
      expect(tokens.access_token).toMatch(/^quits_at_/)
      expect(tokens.refresh_token).toBeUndefined()
      const refresh = await tokenRequest({ grant_type: "refresh_token", refresh_token: "x", client_id })
      expect((await refresh.json()).error).toBe("unauthorized_client")
    })

    it("refuses a reused authorization code and revokes what it issued", async () => {
      const org = await setup()
      const { verifier, challenge } = pkcePair()
      const url = new URL(`${ISSUER}/api/mcp/oauth/authorize`)
      url.search = new URLSearchParams({
        response_type: "code",
        client_id: chatGptClientMetadata.client_id,
        redirect_uri: CHATGPT_REDIRECT,
        code_challenge: challenge,
        code_challenge_method: "S256",
        resource: MCP_URL,
      }).toString()
      const callback = await authorizeInBrowser(context, url, org.actors.admin, approve("read_only"))
      const exchange = (codeVerifier: string, clientId = chatGptClientMetadata.client_id) =>
        tokenRequest({
          grant_type: "authorization_code",
          code: callback.searchParams.get("code")!,
          redirect_uri: CHATGPT_REDIRECT,
          client_id: clientId,
          code_verifier: codeVerifier,
        })

      expect((await exchange(pkcePair().verifier)).status).toBe(400)
      expect((await exchange(verifier, claudeCodeClientMetadata.client_id)).status).toBe(400)
      const tokens = (await (await exchange(verifier)).json()) as Tokens
      expect((await rawMcp(tokens.access_token, "initialize", initializeParams)).response.status).toBe(200)

      expect((await exchange(verifier)).status).toBe(400)
      expect((await rawMcp(tokens.access_token, "initialize", initializeParams)).response.status).toBe(401)
    })

    it("keeps grants isolated and clientRequestId receipts per connection", async () => {
      const org = await setup()
      const first = await connectLikeChatGpt(context, org.actors.admin, approve("drafting_only"))
      const second = await connectLikeChatGpt(context, org.actors.admin, approve("drafting_only"))

      const a = await rawToolCall(first.access_token, "contact_create", { name: "One", clientRequestId: "same-id" })
      const b = await rawToolCall(second.access_token, "contact_create", { name: "Two", clientRequestId: "same-id" })
      expect(a.value.commandId).not.toBe(b.value.commandId)
      expect(await prisma.contact.count({ where: { organizationId: org.organizationId } })).toBe(2)

      const other = await rawToolCall(second.access_token, "command_status", { commandId: a.value.commandId })
      expect(other.value).toMatchObject({ error: { tag: "NotFound" } })

      // A refreshed token is the same connection: a retry returns the first outcome.
      const refreshed = (await (await refreshTokens(first)).json()) as Tokens
      const retry = await rawToolCall(refreshed.access_token, "contact_create", { name: "One", clientRequestId: "same-id" })
      expect(retry.value).toEqual(a.value)
      expect(await prisma.contact.count({ where: { organizationId: org.organizationId } })).toBe(2)
    })

    it("binds a connection to the organization it was granted for", async () => {
      const orgA = await setup()
      const orgB = await setup()
      const user = orgA.actors.admin
      await ensureTestMembership(orgB.organizationId, user.userId, "admin")
      const { key, secret } = await createAgentKey(orgB.actors.admin, {
        name: "B writer",
        mode: "full_access",
        scopes: ["contact:create", "contact:read"],
      })
      expect(key.id).toBeTruthy()
      const inB = await rawToolCall(secret, "contact_create", { name: "Secret B", clientRequestId: "b-1" })
      const contactB = inB.value.result.id as string

      const tokens = await connectLikeChatGpt(context, user, approve("drafting_only"))
      const organization = await rawToolCall(tokens.access_token, "organization_read")
      expect(organization.value.organization.companyName).toContain(orgA.organizationId.slice(0, 8))
      const read = await rawToolCall(tokens.access_token, "contact_get", { id: contactB })
      expect(read.value).toMatchObject({ error: { tag: "NotFound" } })
      const list = await rawToolCall(tokens.access_token, "contacts_list", { search: "Secret" })
      expect(list.value.items).toEqual([])
    })

    it("still accepts agent keys while the prototype is on", async () => {
      const org = await setup()
      const { secret } = await createAgentKey(org.actors.admin, { name: "Key", mode: "read_only", scopes: ["contact:read"] })
      const listed = await rawToolCall(secret, "contacts_list")
      expect(listed.value).toMatchObject({ items: [] })
      const unknown = await rawMcp("quits_ak_unknown", "initialize", initializeParams)
      expect(unknown.response.status).toBe(401)
      expect(unknown.body.error.message).toBe("Invalid agent key")
    })

    it("maps tokens from an extension verifier only onto live installations and this resource", async () => {
      const org = await setup()
      const { key } = await createAgentKey(org.actors.admin, {
        name: "Gateway connection",
        mode: "approval_required",
        scopes: ["contact:read", "contact:create"],
      })
      setMcpAccessTokenVerifiers([
        async (token) =>
          token === "gateway-token"
            ? { agentKeyId: key.id, scopes: ["contact:read", "invoice:send"], clientId: "gw", resource: MCP_URL }
            : token === "foreign-audience"
              ? { agentKeyId: key.id, scopes: ["contact:read"], clientId: "gw", resource: "https://elsewhere.test/mcp" }
              : null,
      ])
      const listed = await rawToolCall("gateway-token", "contacts_list")
      expect(listed.value).toMatchObject({ items: [] })
      // The token cannot add invoice:send to the key, and contact:create is not in the token.
      const tools = await rawMcp("gateway-token", "tools/list")
      expect(tools.body.result.tools.map((tool: { name: string }) => tool.name)).not.toContain("invoice_send")
      expect((await rawToolCall("gateway-token", "contact_create", { name: "x", clientRequestId: "x" })).status).toBe(403)
      expect((await rawMcp("foreign-audience", "initialize", initializeParams)).response.status).toBe(401)

      await revokeAgentKey(org.actors.admin, key.id)
      expect((await rawMcp("gateway-token", "initialize", initializeParams)).response.status).toBe(401)
    })
  })
})
