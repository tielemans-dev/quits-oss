import { afterEach, describe, expect, it, vi } from "vitest"
import { createTestOrganization, hasTestDatabase } from "../../../test-utils/organization"
import { appRouter } from "../../router"
import { prisma } from "../../../lib/db"
import { accountingConnections, connectAccounting } from "../../../domain/accounting/connections"
import { deliverAccounting, type AccountingTransport } from "../../../domain/accounting/delivery"
import { defaultMappings } from "../../../domain/accounting/mappings"
import { dineroProvider } from "../../../domain/accounting/dinero"
import { invoiceFixture } from "../../../domain/accounting/__tests__/fixtures"

const callerFor = (organizationId: string, userId: string) => appRouter.createCaller({
  session: { user: { id: userId, email: `${userId}@test.quits.invalid`, name: userId }, session: { activeOrganizationId: organizationId } },
} as never)

;(hasTestDatabase ? describe : describe.skip)("accounting integrations router", () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => { vi.unstubAllEnvs(); while (cleanups.length) await cleanups.pop()?.() })

  async function failedDelivery() {
    const org = await createTestOrganization({ roles: ["admin", "member", "accountant"] })
    cleanups.push(org.cleanup)
    const scope = { organizationId: org.organizationId, consumerKey: "accounting:dinero:generation-1" }
    await prisma.accountingConnection.create({ data: { organizationId: org.organizationId, status: "connected", provider: "dinero", remoteAccountId: "1234", generation: "generation-1", credentialEnc: "synthetic-unused", mappingRevision: "1" } })
    const invoice = invoiceFixture(), guid = "11111111-1111-4111-8111-111111111111"
    invoice.buyer = { name: "Buyer", country: "DK" }
    for (const sequence of [1, 2]) await prisma.domainEvent.create({ data: { organizationId: org.organizationId, sequence, aggregateType: "invoice", aggregateId: `invoice-${sequence}`, actorKind: "system", type: "invoice.issued", schemaVersion: 1, payload: invoice } })
    await prisma.orgSettings.update({ where: { organizationId: org.organizationId }, data: { eventSequence: 2 } })
    await prisma.eventConsumerCursor.create({ data: { ...scope, scannedSequence: 2 } })
    const first = await prisma.eventConsumerDelivery.create({ data: { ...scope, sequence: 1, status: "failed", attempts: 5, availableAt: new Date("2099-01-01"), error: { code: "http_400" } } })
    await prisma.eventConsumerDelivery.create({ data: { ...scope, sequence: 2 } })
    const admin = callerFor(org.organizationId, org.actors.admin.userId)
    const connections = { find: async () => ({ key: (await prisma.accountingConnection.findUniqueOrThrow({ where: { organizationId: org.organizationId } })).generation, mappingRevision: "1", provider: dineroProvider,
      settings: async () => ({ contactGuid: guid, documentGuid: guid, invoiceLinks: {}, vatMappings: { [invoice.vatGroups[0]!.key]: { accountNumber: 1000 } } }),
      request: (prepared: Extract<ReturnType<typeof dineroProvider.map>, { status: "prepared" }>) => prepared.payload }) }
    const transport = { send: vi.fn(async () => ({ status: 201, externalRef: "remote-draft", totals: { net: "1", tax: "0.25", gross: "1.25" } })), reconcile: vi.fn(async (): Promise<Awaited<ReturnType<AccountingTransport["reconcile"]>>> => ({ status: "absent" })) }
    const run = () => deliverAccounting({ organizationId: org.organizationId, connections, transport })
    return { org, scope, first, admin, run, transport }
  }

  it("audits disconnect once and clears local authorization", async () => {
    const f = await failedDelivery()
    await f.admin.accounting.disconnect()
    await f.admin.accounting.disconnect()
    expect(await prisma.accountingConnection.findUnique({ where: { organizationId: f.org.organizationId } })).toMatchObject({ status: "disconnected", credentialEnc: null })
    const events = await prisma.domainEvent.findMany({ where: { organizationId: f.org.organizationId, type: "accounting.action_recorded" } })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ actorId: f.org.actors.admin.userId, commandId: expect.any(String), payload: { action: "disconnect", provider: "dinero", generation: "generation-1" } })
  })

  it.each(["dinero", "economic"] as const)("saves %s mappings with an audit entry and rejects stale or unauthorized edits", async provider => {
    const f = await failedDelivery(), mappings = defaultMappings()
    await prisma.eventConsumerDelivery.update({ where: { id: f.first.id }, data: { error: { code: "missing_mapping" } } })
    expect((await f.admin.accounting.status()).providers[1]?.delivery?.blockedDocument).toBe("INV-1")
    mappings.rows[0] = { ...mappings.rows[0]!, revenueAccount: 1000, vatCode: "U25", productNumber: "sales" }
    mappings.paymentAccount = 55000
    await prisma.accountingConnection.update({ where: { organizationId: f.org.organizationId }, data: { provider } })
    const input = { provider, generation: "generation-1", mappingRevision: "1", mappings }
    for (const role of ["member", "accountant"] as const)
      await expect(callerFor(f.org.organizationId, f.org.actors[role].userId).accounting.saveMappings(input)).rejects.toMatchObject({ code: "FORBIDDEN" })
    await expect(f.admin.accounting.saveMappings({ ...input, mappings: { ...mappings, paymentAccount: -1 } })).rejects.toMatchObject({ code: "BAD_REQUEST" })
    await expect(f.admin.accounting.saveMappings({ ...input, generation: "old" })).rejects.toMatchObject({ code: "BAD_REQUEST" })
    await expect(f.admin.accounting.saveMappings({ ...input, provider: provider === "dinero" ? "economic" : "dinero" })).rejects.toMatchObject({ code: "BAD_REQUEST" })
    const result = await f.admin.accounting.saveMappings(input)
    expect(result.providers.find(item => item.provider === provider)?.mappings).toEqual(mappings)
    const stored = await prisma.accountingConnection.findUniqueOrThrow({ where: { organizationId: f.org.organizationId } })
    expect(stored.mappingRevision).not.toBe("1")
    const runtime = { settings: vi.fn(), transport: vi.fn() }, connection = await accountingConnections(runtime).find(f.org.organizationId)
    await connection!.settings({ type: "invoice.issued", schemaVersion: 1, payload: {}, id: "event", deliveryId: "delivery" })
    expect(runtime.settings).toHaveBeenCalledWith(expect.objectContaining({ mappings, mappingRevision: stored.mappingRevision }), expect.any(Object))
    await expect(f.admin.accounting.saveMappings(input)).rejects.toMatchObject({ code: "BAD_REQUEST" })
    const events = await prisma.domainEvent.findMany({ where: { organizationId: f.org.organizationId, type: "accounting.mappings_updated" } })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ actorId: f.org.actors.admin.userId, commandId: expect.any(String), payload: { provider, generation: input.generation, previousRevision: "1", revision: stored.mappingRevision } })
    expect(await prisma.eventConsumerDelivery.findUnique({ where: { id: f.first.id } })).toMatchObject({ status: "failed", attempts: 5 })
    await f.admin.accounting.disconnect()
    await expect(f.admin.accounting.saveMappings({ ...input, mappingRevision: stored.mappingRevision })).rejects.toMatchObject({ code: "BAD_REQUEST" })
  })

  it.each(["retry", "skip"] as const)("audits %s, clears backoff and unblocks later documents", async action => {
    const f = await failedDelivery(), input = { deliveryId: f.first.id, reason: " Already entered manually " }
    expect(await f.run()).toBe("failed")
    await f.admin.accounting[action](input)
    const changed = await prisma.eventConsumerDelivery.findUniqueOrThrow({ where: { id: f.first.id } })
    expect(changed.availableAt.getTime()).toBeLessThanOrEqual(Date.now())
    expect(changed).toMatchObject(action === "retry"
      ? { status: "pending", attempts: 0, error: null, claimToken: null, leaseUntil: null, availableAt: expect.any(Date) }
      : { status: "skipped", error: { code: "admin_skipped", reason: input.reason.trim() } })
    if (action === "retry") expect(await f.run()).toBe("delivered")
    expect(await f.run()).toBe("delivered")
    expect((await prisma.eventConsumerCursor.findFirstOrThrow({ where: f.scope })).acknowledgedSequence).toBeGreaterThanOrEqual(2)
    const event = await prisma.domainEvent.findFirstOrThrow({ where: { organizationId: f.org.organizationId, type: "accounting.action_recorded" } })
    expect(event).toMatchObject({ actorId: f.org.actors.admin.userId, commandId: expect.any(String), payload: { action, deliveryId: f.first.id, reason: action === "skip" ? input.reason.trim() : null } })
    await expect(f.admin.accounting[action](input)).rejects.toMatchObject({ code: "BAD_REQUEST" })
    expect(await prisma.domainEvent.count({ where: { organizationId: f.org.organizationId, type: event.type } })).toBe(1)
  })

  it.each(["1234", "different-account"])("retries explicitly on %s with account-specific request handling", async remoteAccountId => {
    const f = await failedDelivery()
    await f.admin.accounting.retry({ deliveryId: f.first.id })
    f.transport.send.mockResolvedValueOnce({ status: 400, externalRef: "", totals: { net: "1", tax: "0.25", gross: "1.25" } })
    expect(await f.run()).toBe("failed")
    const pinned = await prisma.eventConsumerDelivery.findUniqueOrThrow({ where: { id: f.first.id } })
    vi.stubEnv("BETTER_AUTH_SECRET", "synthetic-accounting-test-encryption-key")
    await connectAccounting({ organizationId: f.org.organizationId, provider: "dinero", remoteAccountId, credential: "synthetic", mappingRevision: "1" })
    expect(await f.run()).toBe("failed")
    const deliveryId = (await f.admin.accounting.status()).providers[1]!.delivery!.failedDeliveryId!
    await f.admin.accounting.retry({ deliveryId, confirmReconnect: true })
    f.transport.reconcile.mockResolvedValueOnce({ status: "delivered", externalRef: "recovered", totals: { net: "1", tax: "0.25", gross: "1.25" } })
    expect(await f.run()).toBe("delivered")
    if (remoteAccountId === "1234") {
      expect(f.transport.reconcile).toHaveBeenCalledWith(pinned.prepared, expect.any(AbortSignal))
      expect(f.transport.send).toHaveBeenCalledTimes(1)
    } else {
      expect(f.transport.reconcile).not.toHaveBeenCalled()
      expect(f.transport.send).toHaveBeenCalledTimes(2)
    }
  })

  it.each(["retry", "skip"] as const)("requires an explicit %s decision for old pending deliveries", async action => {
    const f = await failedDelivery()
    await prisma.eventConsumerDelivery.update({ where: { id: f.first.id }, data: { status: "pending" } })
    vi.stubEnv("BETTER_AUTH_SECRET", "synthetic-accounting-test-encryption-key")
    await connectAccounting({ organizationId: f.org.organizationId, provider: "dinero", remoteAccountId: "another-account", credential: "synthetic", mappingRevision: "1" })
    expect(await f.run()).toBe("failed")
    const state = await f.admin.accounting.status(), delivery = state.providers[1]!.delivery!
    expect(delivery.lastErrorCode).toBe("reconnect_review_required")
    const input = { deliveryId: delivery.failedDeliveryId!, reason: "Reviewed previous account", confirmReconnect: true }
    await expect(f.admin.accounting.retry({ deliveryId: input.deliveryId })).rejects.toMatchObject({ code: "BAD_REQUEST" })
    await f.admin.accounting[action](input)
    expect(await prisma.eventConsumerDelivery.findUnique({ where: { id: input.deliveryId } })).toMatchObject({ status: action === "retry" ? "pending" : "skipped" })
    // The original record remains as evidence; the decision belongs to the new generation.
    expect(await prisma.eventConsumerDelivery.findUnique({ where: { id: f.first.id } })).toMatchObject({ status: "failed" })
    const audit = await prisma.domainEvent.findFirstOrThrow({ where: { organizationId: f.org.organizationId, type: "accounting.action_recorded" } })
    expect(audit).toMatchObject({ actorId: f.org.actors.admin.userId, payload: { action, deliveryId: input.deliveryId } })
  })

  it("rejects non-admins, other organizations, old generations and empty skip reasons", async () => {
    const f = await failedDelivery(), other = await failedDelivery(), input = { deliveryId: f.first.id, reason: "Resolved manually" }
    for (const role of ["member", "accountant"] as const) {
      const caller = callerFor(f.org.organizationId, f.org.actors[role].userId)
      await expect(caller.accounting.retry(input)).rejects.toMatchObject({ code: "FORBIDDEN" })
      await expect(caller.accounting.skip(input)).rejects.toMatchObject({ code: "FORBIDDEN" })
    }
    await expect(other.admin.accounting.retry(input)).rejects.toMatchObject({ code: "NOT_FOUND" })
    await expect(f.admin.accounting.skip({ ...input, reason: "  " })).rejects.toMatchObject({ code: "BAD_REQUEST" })
    await prisma.accountingConnection.update({ where: { organizationId: f.org.organizationId }, data: { generation: "new-generation" } })
    await expect(f.admin.accounting.skip(input)).rejects.toMatchObject({ code: "NOT_FOUND" })
    expect(await prisma.eventConsumerDelivery.findUnique({ where: { id: f.first.id } })).toMatchObject({ status: "failed", attempts: 5 })
    expect(await prisma.domainEvent.count({ where: { organizationId: f.org.organizationId, type: "accounting.action_recorded" } })).toBe(0)
  })

  it("reports providers as not connected and lets only admins disconnect", async () => {
    const org = await createTestOrganization({ roles: ["admin", "member"] })
    cleanups.push(org.cleanup)
    const admin = callerFor(org.organizationId, org.actors.admin.userId)
    const member = callerFor(org.organizationId, org.actors.member.userId)

    await expect(admin.accounting.status()).resolves.toMatchObject({ canDisconnect: true,
      providers: [{ provider: "economic", status: "not_connected" }, { provider: "dinero", status: "not_connected" }] })
    await expect(member.accounting.status()).resolves.toMatchObject({ canDisconnect: false })
    await expect(member.accounting.disconnect()).rejects.toMatchObject({ code: "FORBIDDEN" })
    await expect(admin.accounting.disconnect()).resolves.toMatchObject({ canDisconnect: true })
  })
})
