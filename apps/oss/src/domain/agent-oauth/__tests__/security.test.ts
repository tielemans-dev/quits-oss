import { createHash } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const persistence = vi.hoisted(() => ({
  organization: vi.fn(),
  createKey: vi.fn(),
  liveKey: vi.fn(),
}))
vi.mock("../../../lib/db", () => ({ prisma: {
  organization: { findUnique: persistence.organization },
  agentKey: { update: vi.fn() },
} }))
vi.mock("../../agent-keys", () => ({
  createAgentKey: persistence.createKey,
  resolveAgentActorById: persistence.liveKey,
}))

import type { AgentActor, UserActor } from "../../actor"
import { registerDynamicClient } from "../clients"
import { readMcpOAuthConfig } from "../config"
import { authenticateMcpAccessToken, decideConsent, describeConsentRequest, handleToken } from "../server"
import { InMemoryMcpOAuthStore } from "../store"

const now = new Date("2026-10-08T12:00:00Z")
const config = readMcpOAuthConfig({ QUITS_MCP_OAUTH_PROTOTYPE: "true", QUITS_APP_ORIGIN: "http://localhost:3000" })
const user: UserActor = { kind: "user", organizationId: "org-A", userId: "owner", roles: ["admin"], label: "Admin" }
const agent: AgentActor = { kind: "agent", organizationId: "org-A", agentKeyId: "key", ownerRoles: ["admin"], scopes: ["invoice:read"], mode: "read_only", label: "Test" }
const hash = (value: string) => createHash("sha256").update(value).digest("hex")
const approve = { decision: "approve" as const, presetId: "read_only" as const }

function gate() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}

async function fixture() {
  const store = new InMemoryMcpOAuthStore()
  const context = { config, store, fetchMetadata: vi.fn(), now: () => now }
  const client = await registerDynamicClient(store, {
    client_name: "Security client", redirect_uris: ["https://client.example/cb"], grant_types: ["authorization_code", "refresh_token"],
  }, now)
  await store.savePendingAuthorization({
    id: "request", clientId: client.clientId, redirectUri: client.redirectUris[0]!, state: "state",
    codeChallenge: "a".repeat(43), resource: config.resource, requestedScopes: ["invoice:read"], createdAt: now, expiresAt: new Date(+now + 60_000),
  })
  const verifier = "z".repeat(43)
  await store.saveCode({
    codeHash: hash("code"), clientId: client.clientId, redirectUri: client.redirectUris[0]!,
    codeChallenge: createHash("sha256").update(verifier).digest("base64url"), resource: config.resource,
    agentKeyId: "key", organizationId: user.organizationId, userId: user.userId, scopes: ["invoice:read"], presetId: "read_only",
    expiresAt: new Date(+now + 60_000), usedAt: null, familyId: null,
  })
  const exchange = () => handleToken(context, new Request(`${config.issuer}/api/mcp/oauth/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: client.clientId, grant_type: "authorization_code", code: "code", code_verifier: verifier, redirect_uri: client.redirectUris[0]!, resource: config.resource }),
  }))
  return { context, store, client, exchange }
}

beforeEach(() => {
  persistence.organization.mockImplementation(async ({ where }) => ({ name: where.id }))
  persistence.createKey.mockResolvedValue({ key: { id: "key" } })
  persistence.liveKey.mockResolvedValue(agent)
})
afterEach(() => vi.restoreAllMocks())

describe("consent integrity", () => {
  it.each([
    ["organization", { ...user, organizationId: "org-B" }, "session-A"],
    ["user", { ...user, userId: "another-admin" }, "session-A"],
    ["session", user, "session-B"],
    ["permissions", { ...user, roles: ["accountant"] }, "session-A"],
  ] as const)("refuses a change of %s between review and approval without creating an installation", async (_name, current, session) => {
    const { context } = await fixture()
    const review = await describeConsentRequest(context, user, "request", "session-A")
    expect(review.organizationName).toBe("org-A")
    await expect(decideConsent(context, current as UserActor, "request", { ...approve, reviewId: review.reviewId }, session)).rejects.toThrow()
    expect(persistence.createKey).not.toHaveBeenCalled()
  })

  it("rejects an old review after re-render and accepts only the fresh displayed grant once", async () => {
    const { context } = await fixture()
    const old = await describeConsentRequest(context, user, "request", "session-A")
    const current = await describeConsentRequest(context, user, "request", "session-A")
    await expect(decideConsent(context, user, "request", { ...approve, reviewId: old.reviewId }, "session-A")).rejects.toThrow()
    const decision = { ...approve, reviewId: current.reviewId }
    await expect(decideConsent(context, user, "request", decision, "session-A")).resolves.toMatchObject({ agentKeyId: "key" })
    await expect(decideConsent(context, user, "request", decision, "session-A")).rejects.toThrow()
    expect(persistence.createKey).toHaveBeenCalledTimes(1)
    expect(persistence.createKey.mock.calls[0]?.[0].organizationId).toBe("org-A")
  })

  it("requires a review before deciding and rejects changed client metadata", async () => {
    const { context, store, client } = await fixture()
    await expect(decideConsent(context, user, "request", { ...approve, reviewId: "invented" }, "session-A")).rejects.toThrow()
    const review = await describeConsentRequest(context, user, "request", "session-A")
    await store.saveClient({ ...client, clientName: "Changed app" })
    await expect(decideConsent(context, user, "request", { ...approve, reviewId: review.reviewId }, "session-A")).rejects.toThrow()
    expect(persistence.createKey).not.toHaveBeenCalled()
  })
})

describe("authorization code replay windows", () => {
  it("revokes a family when replay arrives during the live membership lookup", async () => {
    const { context, store, exchange } = await fixture()
    const entered = gate()
    const resume = gate()
    persistence.liveKey.mockImplementationOnce(async () => { entered.release(); await resume.promise; return agent })
    const first = exchange()
    await entered.promise
    const replay = await exchange()
    resume.release()
    expect(replay.status).toBe(400)
    const tokens = await (await first).json()
    expect(await authenticateMcpAccessToken(context, tokens.access_token ?? "absent")).toBeNull()
    const code = await store.getCode(hash("code"))
    expect((await store.getFamily(code!.familyId!))?.revokedAt).toEqual(now)
  })

  it("revokes the winner when two requests both read the code as unused", async () => {
    const { context, store, exchange } = await fixture()
    const original = store.getCode.bind(store)
    const bothRead = gate()
    let reads = 0
    vi.spyOn(store, "getCode").mockImplementation(async (codeHash) => {
      const snapshot = await original(codeHash)
      if (++reads === 2) bothRead.release()
      await bothRead.promise
      return snapshot ? { ...snapshot } : null
    })
    const responses = await Promise.all([exchange(), exchange()])
    expect(responses.some((response) => response.status === 400)).toBe(true)
    const code = await original(hash("code"))
    expect((await store.getFamily(code!.familyId!))?.revokedAt).toEqual(now)
    for (const response of responses) {
      const tokens = await response.json()
      expect(await authenticateMcpAccessToken(context, tokens.access_token ?? "absent")).toBeNull()
    }
  })
})
