import { randomUUID } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"
import { prisma } from "../../../lib/db"
import { decryptSecret } from "../../../lib/secrets"
import { setRuntimeServices } from "../../../lib/runtime/services"
import { runSchedulerTick } from "../../scheduler"
import { accountingConnections, connectAccounting, disconnectAccounting, type AccountingDeliveryRuntime } from "../connections"
import { deliverAccounting } from "../delivery"
import { runAccountingTick } from "../scheduled-delivery"
import { creditFixture, invoiceFixture } from "./fixtures"
import { defaultMappings } from "../mappings"

const describeDb = process.env.DATABASE_URL ? describe : describe.skip
describeDb("persisted accounting connections and scheduled delivery", () => {
  const organizations: string[] = []
  afterEach(async () => {
    setRuntimeServices({ accountingDelivery: undefined })
    vi.unstubAllEnvs()
    for (const id of organizations.splice(0)) {
      await prisma.domainEvent.deleteMany({ where: { organizationId: id } })
      await prisma.orgSettings.deleteMany({ where: { organizationId: id } })
      await prisma.organization.delete({ where: { id } })
    }
  })
  async function setup(provider: "economic" | "dinero" = "economic") {
    vi.stubEnv("BETTER_AUTH_SECRET", "synthetic-accounting-test-encryption-key")
    const organizationId = randomUUID(), invoice = invoiceFixture()
    invoice.buyer = { name: "Synthetic buyer", country: "DK" }
    organizations.push(organizationId)
    await prisma.organization.create({ data: { id: organizationId, name: "Accounting test", slug: organizationId, createdAt: new Date() } })
    const event = await prisma.domainEvent.create({ data: { organizationId, sequence: 1, aggregateType: "invoice",
      aggregateId: "invoice", type: "invoice.issued", schemaVersion: 1, payload: invoice, actorKind: "system" } })
    await prisma.orgSettings.upsert({ where: { organizationId }, create: { organizationId, eventSequence: 1 }, update: { eventSequence: 1 } })
    const actor = { kind: "user" as const, organizationId, userId: "synthetic-admin", roles: ["admin" as const], label: "Accounting admin" }
    const input = { actor, organizationId, provider, remoteAccountId: "synthetic-remote", mappingRevision: "1", credential: "synthetic-token", syncStartAt: event.occurredAt }
    await connectAccounting(input)
    const send = vi.fn(async () => ({ status: 201, externalRef: "synthetic-draft", totals: { net: "1", tax: "0.25", gross: "1.25" } }))
    const transport = vi.fn(() => ({ send, reconcile: vi.fn(async () => ({ status: "unknown" as const })) }))
    const guid = "11111111-1111-4111-8111-111111111111"
    const runtime: AccountingDeliveryRuntime = { transport, settings: vi.fn(async () => provider === "economic"
      ? { provider, value: { customerNumber: 42, layoutNumber: 1, paymentTermsNumber: 3,
        vatMappings: { [invoice.vatGroups[0]!.key]: { productNumber: "sales", vatZoneNumber: 1 } } } }
      : { provider, value: { contactGuid: guid, documentGuid: guid, invoiceLinks: {},
        vatMappings: { [invoice.vatGroups[0]!.key]: { accountNumber: 1000 } } } }) }
    const connections = accountingConnections(runtime)
    return { organizationId, event, input, runtime, connections, send, transport }
  }

  it.each(["economic", "dinero"] as const)("looks up %s only within the organization and keeps credentials out of requests", async provider => {
    const f = await setup(provider)
    const stored = await prisma.accountingConnection.findUniqueOrThrow({ where: { organizationId: f.organizationId } })
    expect(stored.credentialEnc).not.toContain("synthetic-token")
    expect(decryptSecret(stored.credentialEnc!)).toBe("synthetic-token")
    const connection = await f.connections.find(f.organizationId)
    expect(connection).toMatchObject({ key: stored.generation, provider: { id: provider }, mappingRevision: "1" })
    expect(connection!.record).not.toHaveProperty("credentialEnc")
    expect(await f.connections.find(randomUUID())).toBeNull()
    expect(await deliverAccounting({ organizationId: f.organizationId, connections: f.connections,
      transport: f.runtime.transport(connection!.record) })).toBe("delivered")
    expect(f.runtime.settings).toHaveBeenCalledWith(connection!.record, expect.objectContaining({ id: f.event.id }))
    expect(f.send).toHaveBeenCalledWith(expect.objectContaining({ providerId: provider,
      path: provider === "economic" ? "/invoices/drafts" : "/invoices" }), expect.any(AbortSignal))
    const delivery = await prisma.eventConsumerDelivery.findFirstOrThrow({ where: { organizationId: f.organizationId } })
    expect(JSON.stringify(delivery.prepared)).not.toContain("synthetic-token")
  })

  it("disconnects idempotently, clears authorization, and skips the organization without scanning", async () => {
    const f = await setup()
    await disconnectAccounting(f.organizationId)
    await disconnectAccounting(f.organizationId)
    expect(await f.connections.find(f.organizationId)).toBeNull()
    expect(await prisma.accountingConnection.findUniqueOrThrow({ where: { organizationId: f.organizationId } }))
      .toMatchObject({ status: "disconnected", credentialEnc: null })
    setRuntimeServices({ accountingDelivery: f.runtime })
    expect(await runAccountingTick(new Date(), { organizationIds: [f.organizationId] })).toMatchObject({ organizations: 0 })
    expect(await deliverAccounting({ organizationId: f.organizationId, connections: f.connections,
      transport: f.runtime.transport({ organizationId: f.organizationId, generation: "unused", provider: "economic", remoteAccountId: "unused", mappingRevision: "1" }) })).toBe("paused")
    expect(await prisma.eventConsumerDelivery.count({ where: { organizationId: f.organizationId } })).toBe(0)
    expect(f.send).not.toHaveBeenCalled()
  })

  it("keeps the invoice mapping revision and account on a later credit", async () => {
    const f = await setup("dinero"), mappings = defaultMappings(), key = invoiceFixture().vatGroups[0]!.key
    mappings.rows[0]!.revenueAccount = 1000
    await prisma.accountingConnection.update({ where: { organizationId: f.organizationId }, data: { mappings } })
    f.runtime.settings = vi.fn(async (connection) => ({ provider: "dinero" as const, value: {
      contactGuid: "11111111-1111-4111-8111-111111111111", documentGuid: "22222222-2222-4222-8222-222222222222",
      invoiceLinks: { invoice: "11111111-1111-4111-8111-111111111111" }, vatMappings: { [key]: { accountNumber: connection.mappings!.rows[0]!.revenueAccount! } },
    } }))
    expect(await deliverAccounting({ organizationId: f.organizationId, connections: f.connections, transport: f.transport() })).toBe("delivered")
    mappings.rows[0]!.revenueAccount = 2000
    await prisma.accountingConnection.update({ where: { organizationId: f.organizationId }, data: { mappings, mappingRevision: "2" } })
    const invoice = invoiceFixture(); invoice.buyer = { name: "Buyer", country: "DK" }
    await prisma.domainEvent.create({ data: { organizationId: f.organizationId, sequence: 3, aggregateType: "credit_note", aggregateId: "credit",
      type: "credit_note.issued", schemaVersion: 2, payload: creditFixture(invoice), actorKind: "system" } })
    f.send.mockResolvedValueOnce({ status: 201, externalRef: "credit-draft", totals: { net: "-1.00", tax: "-0.25", gross: "-1.25" } })
    expect(await deliverAccounting({ organizationId: f.organizationId, connections: f.connections, transport: f.transport() })).toBe("delivered")
    expect(await prisma.eventConsumerDelivery.findFirstOrThrow({ where: { organizationId: f.organizationId, sequence: 3 } }))
      .toMatchObject({ prepared: { mappingRevision: "1", body: { ProductLines: [{ AccountNumber: 1000 }] } } })
  })

  it("refuses settings for another provider without sending", async () => {
    const f = await setup(), other = await setup("dinero")
    setRuntimeServices({ accountingDelivery: { ...f.runtime, settings: other.runtime.settings } })
    expect(await runAccountingTick(new Date(), { organizationIds: [f.organizationId] })).toMatchObject({ failed: 1 })
    expect(f.send).not.toHaveBeenCalled()
    expect(await prisma.eventConsumerDelivery.findFirstOrThrow({ where: { organizationId: f.organizationId } }))
      .toMatchObject({ error: { code: "provider_mismatch" } })
  })

  it("defaults to the connection time and honors a chosen inclusive start", async () => {
    const f = await setup()
    expect(await deliverAccounting({ organizationId: f.organizationId, connections: f.connections, transport: f.transport() })).toBe("delivered")
    const other = await setup()
    await prisma.accountingConnection.delete({ where: { organizationId: other.organizationId } })
    const { syncStartAt: _, ...input } = other.input
    await prisma.domainEvent.update({ where: { id: other.event.id }, data: { occurredAt: new Date("2020-01-01") } })
    await connectAccounting(input)
    expect(await deliverAccounting({ organizationId: other.organizationId, connections: other.connections, transport: other.transport() })).toBe("idle")
    expect(other.send).not.toHaveBeenCalled()
  })

  it.each(["synthetic-remote", "another-remote"])("never replays delivered events after reconnecting to %s", async remoteAccountId => {
    const f = await setup(), transport = f.transport(), mappings = defaultMappings()
    await prisma.accountingConnection.update({ where: { organizationId: f.organizationId }, data: { mappings } })
    expect(await deliverAccounting({ organizationId: f.organizationId, connections: f.connections, transport })).toBe("delivered")
    await disconnectAccounting(f.organizationId)
    await connectAccounting({ ...f.input, remoteAccountId })
    expect(await deliverAccounting({ organizationId: f.organizationId, connections: f.connections, transport })).toBe("idle")
    expect(f.send).toHaveBeenCalledTimes(1)
    expect(await prisma.eventConsumerDelivery.count({ where: { organizationId: f.organizationId, status: "done" } })).toBe(1)
    expect((await f.connections.find(f.organizationId))!.syncStartAt).toEqual(f.event.occurredAt)
    expect((await f.connections.find(f.organizationId))!.record.mappings).toEqual(remoteAccountId === f.input.remoteAccountId ? mappings : undefined)
  })

  it("starts a new generation when reconnecting to another remote account", async () => {
    const f = await setup(), before = await f.connections.find(f.organizationId)
    await disconnectAccounting(f.organizationId)
    await connectAccounting({ ...f.input, remoteAccountId: "another-remote" })
    const after = await f.connections.find(f.organizationId)
    expect(after!.key).not.toBe(before!.key)
    expect(after!.record.remoteAccountId).toBe("another-remote")
    expect(await prisma.accountingConnection.count({ where: { organizationId: f.organizationId } })).toBe(1)
  })

  it("does not replace an existing connection when encryption fails", async () => {
    const f = await setup(), before = await f.connections.find(f.organizationId)
    vi.stubEnv("BETTER_AUTH_SECRET", "")
    await expect(connectAccounting({ ...f.input, remoteAccountId: "replacement" })).rejects.toThrow()
    expect(await f.connections.find(f.organizationId)).toMatchObject({ key: before!.key, record: { remoteAccountId: "synthetic-remote" } })
  })

  it("leaves events untouched when no delivery runtime is configured", async () => {
    const f = await setup()
    setRuntimeServices({ accountingDelivery: undefined })
    expect(await runAccountingTick()).toEqual({ disabled: 1 })
    expect(await prisma.eventConsumerDelivery.count({ where: { organizationId: f.organizationId } })).toBe(0)
    expect(f.transport).not.toHaveBeenCalled()
  })

  it("invokes delivery through the registered scheduler task, respecting organization scope", async () => {
    const f = await setup(), other = await setup("dinero")
    setRuntimeServices({ accountingDelivery: f.runtime })
    const scope = { organizationIds: [f.organizationId] }
    expect((await runSchedulerTick(new Date(), scope)).accounting).toMatchObject({ delivered: 1, processed: 1 })
    expect(f.transport).toHaveBeenCalledWith(expect.objectContaining({ organizationId: f.organizationId, remoteAccountId: "synthetic-remote" }))
    expect(await prisma.eventConsumerDelivery.count({ where: { organizationId: other.organizationId } })).toBe(0)
    expect((await runSchedulerTick(new Date(), scope)).accounting).toMatchObject({ idle: 1 })
    expect(f.send).toHaveBeenCalledTimes(1)
  })

  it("reports safe failure counts when a transport factory throws", async () => {
    const f = await setup()
    f.transport.mockImplementation(() => { throw new Error("synthetic private provider details") })
    setRuntimeServices({ accountingDelivery: f.runtime })
    const result = await runAccountingTick(new Date(), { organizationIds: [f.organizationId] })
    expect(result).toMatchObject({ failed: 1, processed: 1 })
    expect(JSON.stringify(result)).not.toContain("private")
  })
})
