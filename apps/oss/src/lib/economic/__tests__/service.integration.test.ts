import { afterEach, describe, expect, it, vi } from "vitest"
import { prisma } from "../../db"
import { createTestOrganization, hasTestDatabase } from "../../../test-utils/organization"
import { EconomicConnector } from "../service"
import { canonical } from "../shapes"
import { parseExactJson, sha256 } from "../client"
import { fixtureFetch, fixtureResponse } from "./fixtures"

const credentials = { appSecret: "synthetic-app-secret", grantToken: "synthetic-grant-secret" }
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); vi.unstubAllEnvs() })
async function setup(transport = fixtureFetch) {
  vi.stubEnv("BETTER_AUTH_SECRET", "synthetic-encryption-secret-for-local-tests-only")
  const org = await createTestOrganization({ roles: ["admin", "accountant", "member"] })
  cleanup.push(async () => {
    await prisma.economicSourceEvidence.deleteMany({ where: { organizationId: org.organizationId } })
    await prisma.economicReadOperation.deleteMany({ where: { connection: { organizationId: org.organizationId } } })
    await prisma.economicConnection.deleteMany({ where: { organizationId: org.organizationId } })
    await org.cleanup()
  })
  const connector = new EconomicConnector(prisma, transport)
  return { ...org, connector, actor: org.actors.admin }
}
;(hasTestDatabase ? describe : describe.skip)("durable e-conomic read staging", () => {
  it("encrypts secrets, binds the account and supports a durable replay after credential deletion", async () => {
    const calls = vi.fn(fixtureFetch)
    const { actor, connector, organizationId } = await setup(calls)
    const connected = await connector.connect(actor, "123", credentials, null)
    const stored = await prisma.economicConnection.findUniqueOrThrow({ where: { organizationId } })
    expect(stored.encryptedCredentials).not.toContain(credentials.grantToken)
    const first = await connector.dryRun(actor, connected.generation, "read-1")
    expect(first.state).toBe("needs_review")
    const count = calls.mock.calls.length
    expect(await new EconomicConnector(prisma, calls).dryRun(actor, connected.generation, "read-1")).toEqual(first)
    expect(calls).toHaveBeenCalledTimes(count)
    expect((await prisma.economicConnection.findUniqueOrThrow({ where: { organizationId } })).encryptedCredentials).toBeNull()
    const report = await connector.readReport(actor, first.id)
    expect(report?.manifestHash).toBe(sha256(canonical(report?.manifest)))
    expect(await prisma.invoice.count({ where: { organizationId } })).toBe(0)
    expect(await prisma.payment.count({ where: { organizationId } })).toBe(0)
    expect(await prisma.job.count({ where: { organizationId } })).toBe(0)
  })
  it("denies member management and foreign report/artifact access, rechecks membership", async () => {
    const one = await setup(), two = await setup()
    await expect(one.connector.connect(one.actors.member, "123", credentials, null)).rejects.toMatchObject({ code: "forbidden" })
    const connected = await one.connector.connect(one.actor, "123", credentials, null)
    const run = await one.connector.dryRun(one.actor, connected.generation, "scope")
    const evidence = await prisma.economicSourceEvidence.findFirstOrThrow({ where: { organizationId: one.organizationId, kind: "invoice" } })
    expect(await two.connector.readReport(two.actor, run.id)).toBeNull()
    expect(await two.connector.readArtifact(two.actor, evidence.id)).toBeNull()
    expect(await one.connector.readReport(one.actors.accountant, run.id)).not.toBeNull()
    await prisma.member.updateMany({ where: { organizationId: one.organizationId, userId: one.actor.userId }, data: { role: "member" } })
    await expect(one.connector.readReport(one.actor, run.id)).rejects.toMatchObject({ code: "forbidden" })
  })
  it("coalesces concurrent identical requests without duplicate evidence", async () => {
    const { actor, connector, organizationId } = await setup()
    const connected = await connector.connect(actor, "123", credentials, null)
    const results = await Promise.all([connector.dryRun(actor, connected.generation, "same"), connector.dryRun(actor, connected.generation, "same")])
    expect(results[0]!.id).toBe(results[1]!.id)
    expect(await prisma.economicReadOperation.count({ where: { connection: { organizationId } } })).toBe(1)
    expect(await prisma.economicSourceEvidence.count({ where: { organizationId } })).toBe(5)
  })
  it("reconnects without duplicating identities or allowing an old generation/account", async () => {
    const { actor, connector, organizationId } = await setup()
    const one = await connector.connect(actor, "123", credentials, null)
    await connector.dryRun(actor, one.generation, "one")
    const two = await connector.connect(actor, "123", { ...credentials, grantToken: "new-synthetic-token" }, one.generation)
    await expect(connector.dryRun(actor, one.generation, "one")).rejects.toMatchObject({ code: "stale_connection" })
    expect((await connector.dryRun(actor, two.generation, "two")).state).toBe("needs_review")
    expect(await prisma.economicSourceEvidence.count({ where: { organizationId } })).toBe(5)
    await expect(connector.connect(actor, "456", credentials, two.generation)).rejects.toMatchObject({ code: "account_mismatch" })
  })
  it("refuses account mismatch and wipes failed preflight credentials", async () => {
    const { actor, connector, organizationId } = await setup()
    await expect(connector.connect(actor, "456", credentials, null)).rejects.toMatchObject({ code: "account_mismatch" })
    expect((await prisma.economicConnection.findUniqueOrThrow({ where: { organizationId } })).encryptedCredentials).toBeNull()
  })
  it("persists safe failures without partial records and keeps repeated attempts inert", async () => {
    let fail = false
    const transport = (async input => fail ? new Response("synthetic-grant-secret", { status: 401 }) : fixtureResponse(new URL(String(input)))) as typeof fetch
    const { actor, connector, organizationId } = await setup(transport)
    const connected = await connector.connect(actor, "123", credentials, null)
    fail = true
    const result = await connector.dryRun(actor, connected.generation, "revoked")
    expect(result.state).toBe("failed")
    expect(await connector.readReport(actor, result.id)).toMatchObject({ failureCode: "revoked", manifest: null })
    expect(await prisma.economicSourceEvidence.count({ where: { organizationId } })).toBe(0)
    expect(await connector.readState(actor)).toMatchObject({ state: "revoked" })
  })
  it("disconnect waits for admitted read and fences every subsequent request and commit", async () => {
    let release!: () => void, started!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    const admitted = new Promise<void>(resolve => { started = resolve })
    let block = false, calls = 0
    const transport = (async input => {
      calls++
      if (block) { block = false; started(); await blocked }
      return fixtureResponse(new URL(String(input)))
    }) as typeof fetch
    const { actor, connector, organizationId } = await setup(transport)
    const connected = await connector.connect(actor, "123", credentials, null)
    block = true
    const run = connector.dryRun(actor, connected.generation, "interrupt")
    await admitted
    const disconnect = connector.disconnect(actor, connected.generation)
    // Wait until the actual PostgreSQL session is queued on the row lock.
    for (let i = 0; i < 100; i++) {
      const waiting = await prisma.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%SELECT id FROM organization%'`
      if (Number(waiting[0]?.count)) break
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    const atDisconnect = calls
    release()
    await disconnect
    expect((await run).state).toBe("interrupted")
    expect(calls).toBe(atDisconnect)
    expect(await prisma.economicSourceEvidence.count({ where: { organizationId } })).toBe(0)
    expect(await connector.readState(actor)).toMatchObject({ state: "disconnected" })
  })
  it("keeps historical intent and original bytes immutable at the database boundary", async () => {
    const { actor, connector, organizationId } = await setup()
    const connected = await connector.connect(actor, "123", credentials, null)
    await connector.dryRun(actor, connected.generation, "immutable")
    const row = await prisma.economicSourceEvidence.findFirstOrThrow({ where: { organizationId, kind: "invoice" } })
    await expect(prisma.economicSourceEvidence.update({ where: { id: row.id }, data: { origin: "quits", intent: "export_revenue" } })).rejects.toThrow()
    await expect(prisma.economicSourceEvidence.update({ where: { id: row.id }, data: { artifactBytes: new Uint8Array([1]) } })).rejects.toThrow()
    await connector.disconnect(actor, connected.generation)
    expect(await connector.readArtifact(actor, row.id)).toMatchObject({ artifactHash: row.artifactHash })
    await expect(prisma.economicConnection.update({ where: { id: connected.connectionId }, data: { accountVerified: false } })).rejects.toThrow()
    await expect(prisma.economicConnection.update({ where: { id: connected.connectionId }, data: { accountId: "456" } })).rejects.toThrow()
  })
  it("rolls back changed source revisions without replacing originals", async () => {
    let changed = false
    const transport = (async input => {
      const url = new URL(String(input))
      if (changed && url.pathname === "/customers") return Response.json({ collection: [{ customerNumber: 7, name: "Changed", currency: "DKK", balance: 125 }], pagination: {} })
      return fixtureResponse(url)
    }) as typeof fetch
    const { actor, connector, organizationId } = await setup(transport)
    const one = await connector.connect(actor, "123", credentials, null)
    await connector.dryRun(actor, one.generation, "original")
    const before = await prisma.economicSourceEvidence.findMany({ where: { organizationId }, orderBy: { id: "asc" } })
    changed = true
    const two = await connector.connect(actor, "123", credentials, one.generation)
    const result = await connector.dryRun(actor, two.generation, "changed")
    expect(result.state).toBe("failed")
    expect(await connector.readReport(actor, result.id)).toMatchObject({ failureCode: "source_drift" })
    expect(await prisma.economicSourceEvidence.findMany({ where: { organizationId }, orderBy: { id: "asc" } })).toEqual(before)
  })
  it("keeps identical source IDs in different organizations separate", async () => {
    const one = await setup(), two = await setup()
    for (const org of [one, two]) {
      const connected = await org.connector.connect(org.actor, "123", credentials, null)
      expect((await org.connector.dryRun(org.actor, connected.generation, "same")).state).toBe("needs_review")
    }
    expect(await prisma.economicSourceEvidence.count({ where: { organizationId: { in: [one.organizationId, two.organizationId] } } })).toBe(10)
  })
  it("serializes competing reconnects and leaves abandoned operations visible until explicit reconnect", async () => {
    const { actor, connector } = await setup()
    const one = await connector.connect(actor, "123", credentials, null)
    const abandoned = await prisma.economicReadOperation.create({ data: { connectionId: one.connectionId, generation: one.generation, requestKey: "abandoned" } })
    expect(await connector.dryRun(actor, one.generation, "abandoned")).toEqual({ id: abandoned.id, state: "pending" })
    await expect(connector.dryRun(actor, one.generation, "different")).rejects.toMatchObject({ code: "operation_conflict" })
    const outcomes = await Promise.allSettled([connector.connect(actor, "123", credentials, one.generation), connector.connect(actor, "123", credentials, one.generation)])
    expect(outcomes.filter(r => r.status === "fulfilled")).toHaveLength(1)
    expect(await connector.readReport(actor, abandoned.id)).toMatchObject({ state: "interrupted" })
  })

  it.each([false, true])("corrects an unverified first agreement after disconnect=%s and stops after self", async disconnectFirst => {
    const calls = vi.fn(fixtureFetch)
    const { actor, connector } = await setup(calls)
    await expect(connector.connect(actor, "456", credentials, null)).rejects.toMatchObject({ code: "account_mismatch" })
    expect.soft(calls.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(["/self"])
    if (disconnectFirst) await connector.disconnect(actor, 1)
    const corrected = await connector.connect(actor, "123", credentials, disconnectFirst ? 2 : 1)
    expect(corrected).toMatchObject({ accountId: "123", readable: true, generation: disconnectFirst ? 3 : 2 })
    expect(await connector.readState(actor)).toMatchObject({ accountVerified: true })
    await connector.disconnect(actor, corrected.generation)
    await expect(connector.connect(actor, "456", credentials, corrected.generation + 1)).rejects.toMatchObject({ code: "account_mismatch" })
  })
  it("keeps a verified binding when later role probes or reconnect fail", async () => {
    let mode: "roles" | "ok" | "wrong" = "roles"
    const transport = (async input => {
      const url = new URL(String(input))
      if (mode === "wrong" && url.pathname === "/self") return Response.json({ agreementNumber: 456, settings: { baseCurrency: "DKK" } })
      if (mode === "roles" && url.pathname !== "/self") return new Response(null, { status: 403 })
      return fixtureResponse(url)
    }) as typeof fetch
    const { actor, connector } = await setup(transport)
    expect(await connector.connect(actor, "123", credentials, null)).toMatchObject({ readable: false })
    await expect(connector.connect(actor, "456", credentials, 1)).rejects.toMatchObject({ code: "account_mismatch" })
    mode = "wrong"
    await expect(connector.connect(actor, "123", credentials, 1)).rejects.toMatchObject({ code: "account_mismatch" })
    await expect(connector.connect(actor, "456", credentials, 2)).rejects.toMatchObject({ code: "account_mismatch" })
    mode = "ok"
    expect(await connector.connect(actor, "123", credentials, 2)).toMatchObject({ readable: true })
  })
  it("preserves exact typed source JSON and verifiable hashes through PostgreSQL", async () => {
    let changed = false
    const source = () => `{"customerNumber":7,"name":"Synthetic","balance":90071992547409.93,"extension":${changed ? '{"lexeme":"1.00"}' : '1.00'},"nested":[null,true,"1.00",{"lexeme":"1.00"},-0,1e3]}`
    const transport = (async input => new URL(String(input)).pathname === "/customers" ? new Response(`{"collection":[${source()}],"pagination":{"results":1}}`, { headers: { "content-type": "application/json" } }) : fixtureResponse(new URL(String(input)))) as typeof fetch
    const { actor, connector, organizationId } = await setup(transport)
    const connected = await connector.connect(actor, "123", credentials, null)
    const operation = await connector.dryRun(actor, connected.generation, "typed-original")
    const row = await prisma.economicSourceEvidence.findFirstOrThrow({ where: { organizationId, kind: "customer" } })
    const saved = row.data as { source: unknown; normalized: { balanceBase: string } }
    expect.soft(typeof saved.source).toBe("string")
    if (typeof saved.source === "string") {
      expect(parseExactJson(saved.source)).toEqual(parseExactJson(source()))
      expect(row.sourceHash).toBe(sha256(saved.source))
    }
    expect(saved.normalized.balanceBase).toBe("9007199254740993")
    const report = await connector.readReport(actor, operation.id)
    expect(report?.manifestHash).toBe(sha256(canonical(report?.manifest)))
    changed = true
    const next = await connector.connect(actor, "123", credentials, connected.generation)
    const outcome = await connector.dryRun(actor, next.generation, "typed-change")
    expect.soft(outcome.state).toBe("failed")
    expect.soft(await connector.readReport(actor, outcome.id)).toMatchObject({ failureCode: "source_drift" })
    expect(await prisma.economicSourceEvidence.findUnique({ where: { id: row.id } })).toEqual(row)
  })
  it("expires a queued PostgreSQL fence, disconnects, and never retries the old grant", async () => {
    const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r }); return { promise, resolve } }
    const firstStarted = deferred(), firstRelease = deferred(), holderReady = deferred(), holderRelease = deferred(), slowStarted = deferred(), slowRelease = deferred()
    let active = false, attempts = 0, slowSignal: AbortSignal | null | undefined
    const events: Array<{ name: string; ms: number; attempts: number }> = []
    let began = 0
    const event = (name: string) => events.push({ name, ms: Date.now() - began, attempts })
    const transport = (async (input, init) => {
      if (active) {
        attempts++
        if (attempts === 1) { firstStarted.resolve(); await firstRelease.promise }
        if (attempts === 2) {
          event("slow_attempt_admitted"); slowSignal = init?.signal; slowStarted.resolve()
          // Deliberately ignores abort, so the actual Prisma timeout must release the row lock.
          await slowRelease.promise
          event("late_429_after_disconnect")
          return new Response(null, { status: 429, headers: { "retry-after": "0" } })
        }
      }
      return fixtureResponse(new URL(String(input)))
    }) as typeof fetch
    const { actor, connector, organizationId } = await setup(transport)
    const connected = await connector.connect(actor, "123", credentials, null)
    active = true; began = Date.now()
    const waitForLock = async () => {
      for (let i = 0; i < 500; i++) {
        const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%SELECT id FROM organization%'`
        if (Number(rows[0]?.count)) return
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      throw new Error("Expected a PostgreSQL row-lock waiter")
    }
    const running = connector.dryRun(actor, connected.generation, "expired-fence")
    await firstStarted.promise
    const holder = prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM organization WHERE id = ${organizationId} FOR UPDATE`
      holderReady.resolve(); await holderRelease.promise
    }, { timeout: 30_000 })
    try {
      await waitForLock(); firstRelease.resolve(); await holderReady.promise
      await waitForLock(); event("read_queued_on_holder")
      await new Promise(resolve => setTimeout(resolve, 12_000))
      holderRelease.resolve(); await holder; await slowStarted.promise
      const disconnect = connector.disconnect(actor, connected.generation)
      await waitForLock(); event("disconnect_queued")
      await disconnect; event("disconnect_committed_after_transaction_expiry")
      const atDisconnect = attempts
      expect.soft(slowSignal?.aborted).toBe(true)
      slowRelease.resolve()
      expect((await running).state).toBe("interrupted")
      expect(atDisconnect).toBe(2)
      expect(attempts).toBe(atDisconnect)
      expect(await prisma.economicSourceEvidence.count({ where: { organizationId } })).toBe(0)
      expect(await connector.readState(actor)).toMatchObject({ state: "disconnected", generation: connected.generation + 1 })
    } finally {
      firstRelease.resolve(); holderRelease.resolve(); slowRelease.resolve()
      await Promise.allSettled([holder, running])
      console.log(JSON.stringify({ regression: "queued-fence-expiry", events }))
    }
  }, 30_000)

})
