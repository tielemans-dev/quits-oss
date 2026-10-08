import { createHash } from "node:crypto"
import { afterEach, describe, expect, it } from "vitest"
import { createTestOrganization, hasTestDatabase } from "../../test-utils/organization"
import { createAgentKey } from "../agent-keys"
import type { AgentActor } from "../actor"
import { runAgentTool } from "../agent-tools/mcp"

// This branch must not import the unmerged OAuth candidate. Once its modules land,
// Vite discovers them locally and this combined integration case becomes active.
const modules = import.meta.glob("../agent-oauth/{server,__tests__/harness}.ts")
const serverPath = "../agent-oauth/server.ts"
const harnessPath = "../agent-oauth/__tests__/harness.ts"
const available = Boolean(modules[serverPath] && modules[harnessPath])

interface OAuthContext {
  config: { resource: string }
  now: () => Date
  store: {
    saveCode(value: object): Promise<void>
    consumeCode(hash: string, now: Date, family: object): Promise<boolean>
    saveAccessToken(value: object): Promise<void>
  }
}

describe.skipIf(!hasTestDatabase || !available)("OAuth access-token / consequence-preview integration", () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => { while (cleanups.length) await cleanups.pop()?.() })

  it("denies command_preview when a valid token is narrower than its full-access installation", async () => {
    const { authenticateMcpAccessToken } = await modules[serverPath]!() as {
      authenticateMcpAccessToken(context: OAuthContext, token: string): Promise<{ actor: AgentActor } | null>
    }
    const { testOAuthContext } = await modules[harnessPath]!() as {
      testOAuthContext(): OAuthContext
    }
    const org = await createTestOrganization()
    cleanups.push(org.cleanup)
    const { key } = await createAgentKey(org.actors.admin, {
      name: "OAuth preview scope test", mode: "full_access", scopes: ["invoice:read", "invoice:send"],
    })
    const context = testOAuthContext(), now = context.now()
    const token = "quits_at_consequence_preview_test_fixture"
    const family = {
      id: "preview-family", clientId: "preview-client", agentKeyId: key.id,
      organizationId: org.organizationId, userId: org.actors.admin.userId,
      resource: context.config.resource, scopes: ["invoice:read", "invoice:send"],
      presetId: "full_access", createdAt: now, revokedAt: null,
    }
    // Seed an opaque token in the prototype's real store. No provider or network call.
    await context.store.saveCode({
      ...family, codeHash: "preview-code", redirectUri: "https://client.example.test/callback",
      codeChallenge: "fixture", expiresAt: new Date(now.getTime() + 60_000), usedAt: null, familyId: null,
    })
    expect(await context.store.consumeCode("preview-code", now, family)).toBe(true)
    await context.store.saveAccessToken({
      tokenHash: createHash("sha256").update(token).digest("hex"), familyId: family.id,
      clientId: family.clientId, agentKeyId: key.id, resource: context.config.resource,
      scopes: ["invoice:read"], expiresAt: new Date(now.getTime() + 60_000),
    })
    const authenticated = await authenticateMcpAccessToken(context, token)
    expect(authenticated?.actor.scopes).toEqual(["invoice:read"])
    if (!authenticated) throw new Error("The seeded OAuth token must authenticate")
    // Authorization must fail before even looking up the invoice, never with NotFound.
    expect(await runAgentTool(authenticated.actor, "command_preview", {
      commandType: "invoice.send", command: { id: "unread-invoice", allowSendWithoutEmail: true },
      includeDocument: false,
    })).toMatchObject({ ok: false, error: { tag: "Forbidden" } })
  })
})
