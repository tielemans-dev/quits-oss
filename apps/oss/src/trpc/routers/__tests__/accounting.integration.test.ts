import { afterEach, describe, expect, it } from "vitest"
import { createTestOrganization, hasTestDatabase } from "../../../test-utils/organization"
import { appRouter } from "../../router"
import { prisma } from "../../../lib/db"
import { deliverAccounting } from "../../../domain/accounting/delivery"
import { dineroProvider } from "../../../domain/accounting/dinero"
import { invoiceFixture } from "../../../domain/accounting/__tests__/fixtures"

const callerFor = (organizationId: string, userId: string) => appRouter.createCaller({
  session: { user: { id: userId, email: `${userId}@test.quits.invalid`, name: userId }, session: { activeOrganizationId: organizationId } },
} as never)

;(hasTestDatabase ? describe : describe.skip)("accounting integrations router", () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => { while (cleanups.length) await cleanups.pop()?.() })

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
    const connections = { find: async () => ({ key: "generation-1", mappingRevision: "1", provider: dineroProvider,
      settings: async () => ({ contactGuid: guid, documentGuid: guid, invoiceLinks: {}, vatMappings: { [invoice.vatGroups[0]!.key]: { accountNumber: 1000 } } }),
      request: (prepared: Extract<ReturnType<typeof dineroProvider.map>, { status: "prepared" }>) => prepared.payload }) }
    const run = () => deliverAccounting({ organizationId: org.organizationId, connections, transport: { send: async () => ({ status: 201, externalRef: "remote-draft" }), reconcile: async () => ({ status: "absent" as const }) } })
    return { org, scope, first, admin, run }
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
