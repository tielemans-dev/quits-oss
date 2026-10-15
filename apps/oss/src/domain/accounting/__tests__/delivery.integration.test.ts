import { randomUUID } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"
import { prisma } from "../../../lib/db"
import { dineroProvider, type DineroSettings } from "../dinero"
import { economicProvider } from "../economic"
import { deliverAccounting, type AccountingTransport } from "../delivery"
import { creditFixture, invoiceFixture } from "./fixtures"

const guid = "11111111-1111-4111-8111-111111111111"
const describeDb = process.env.DATABASE_URL ? describe : describe.skip
describeDb("accounting delivery", () => {
  const organizations: string[] = []
  afterEach(async () => {
    for (const id of organizations.splice(0)) {
      await prisma.domainEvent.deleteMany({ where: { organizationId: id } })
      await prisma.organization.delete({ where: { id } })
    }
  })
  async function setup(type = "invoice.issued") {
    const organizationId = randomUUID(), invoice = invoiceFixture()
    invoice.buyer = { name: "Buyer", country: "DK" }
    organizations.push(organizationId)
    await prisma.organization.create({ data: { id: organizationId, name: "Accounting fixture", slug: organizationId, createdAt: new Date() } })
    const event = await prisma.domainEvent.create({ data: { organizationId, sequence: 1, aggregateType: "invoice",
      aggregateId: "invoice", actorKind: "system", type, schemaVersion: type === "credit_note.issued" ? 2 : 1,
      payload: type === "credit_note.issued" ? creditFixture(invoice) : type === "payment.recorded"
        ? { paymentId: "payment", number: "INV-1", amount: "1.25", currency: "DKK", method: "bank_transfer", balanceDue: "0.00", paymentStatus: "paid" } : invoice } })
    const settings: DineroSettings = { contactGuid: guid, documentGuid: guid, invoiceLinks: { invoice: guid },
      vatMappings: { [invoice.vatGroups[0]!.key]: { accountNumber: 1000 } },
      payment: { paymentId: "payment", invoiceNumber: "INV-1", invoiceGuid: guid, timestamp: "version",
        depositAccountNumber: 55000, paymentDate: "2026-10-08", baseAmount: "1.25", settlement: "gross_no_fees" } }
    const connection = { key: "generation-1", mappingRevision: "1", provider: dineroProvider,
      settings: vi.fn(async () => settings), request: (payload: ReturnType<typeof dineroProvider.map> & { status: "prepared" }) => payload.payload }
    const transport: AccountingTransport = { send: vi.fn(async (request: Parameters<AccountingTransport["send"]>[0]) => ({ status: 201, externalRef: "remote-draft", totals: request.expectedTotals })),
      reconcile: vi.fn(async () => ({ status: "absent" as const })) }
    const connections = { find: vi.fn(async () => connection) }
    const now = new Date()
    const run = (time = now) => deliverAccounting({ organizationId, connections, transport, clock: () => time })
    const row = () => prisma.eventConsumerDelivery.findFirstOrThrow({ where: { organizationId }, orderBy: { sequence: "asc" } })
    return { organizationId, event, connection, connections, transport, run, row, now }
  }
  it.each(["invoice.issued", "credit_note.issued", "payment.recorded"])("delivers %s once, even on a duplicate scan", async type => {
    const f = await setup(type)
    expect(await f.run()).toBe("delivered")
    const row = await f.row()
    expect(row).toMatchObject({ status: "done", attempts: 1, externalRef: "remote-draft", error: null })
    expect(row.prepared).toMatchObject({ eventId: f.event.id, mappingRevision: "1", idempotencyKey: `${row.id}:request` })
    expect(await f.run()).toBe("idle")
    expect(f.transport.send).toHaveBeenCalledTimes(1)
    expect(await prisma.eventConsumerCursor.findFirstOrThrow({ where: { organizationId: f.organizationId } })).toMatchObject({ acknowledgedSequence: 1 })
  })
  it("backs off a transient failure, then reuses pinned bytes after mappings change", async () => {
    const f = await setup()
    vi.mocked(f.transport.send).mockResolvedValueOnce({ status: 503 })
    expect(await f.run()).toBe("pending")
    const row = await f.row()
    expect(row).toMatchObject({ status: "pending", attempts: 1, error: { code: "http_503" } })
    expect(row.availableAt.getTime() - f.now.getTime()).toBeGreaterThanOrEqual(1000)
    expect(await f.run(new Date(row.availableAt.getTime() - 1))).toBe("idle")
    f.connection.mappingRevision = "2"
    f.connection.settings.mockRejectedValue(new Error("must not remap"))
    expect(await f.run(row.availableAt)).toBe("delivered")
    expect(await f.row()).toMatchObject({ status: "done", attempts: 2, error: null })
    expect(vi.mocked(f.transport.send).mock.calls[0][0]).toEqual(vi.mocked(f.transport.send).mock.calls[1][0])
    expect(f.transport.reconcile).toHaveBeenCalledTimes(1)
  })
  it("persists source evidence and provider discrepancies, then refuses changed-source retries", async () => {
    const f = await setup()
    vi.mocked(f.transport.send).mockResolvedValueOnce({ status: 201, externalRef: "voucher-42", totals: { net: "1", tax: "0.24", gross: "1.24" } })
    expect(await f.run()).toBe("failed")
    const row = await f.row()
    expect(row).toMatchObject({ externalRef: "voucher-42", response: { totals: { tax: "0.24" } },
      evidence: { source: { payload: f.event.payload } }, error: { code: "provider_totals_mismatch" } })
    await prisma.domainEvent.update({ where: { id: f.event.id }, data: { payload: { ...invoiceFixture(), number: "Changed" } } })
    await prisma.eventConsumerDelivery.update({ where: { id: row.id }, data: { status: "pending", attempts: 0 } })
    expect(await f.run()).toBe("failed")
    expect(await f.row()).toMatchObject({ error: { code: "source_review_required" }, prepared: row.prepared, response: row.response })
    expect(f.transport.send).toHaveBeenCalledTimes(1)
  })
  it("reconciles pinned requests even after an admin resets the attempt budget", async () => {
    const f = await setup()
    vi.mocked(f.transport.send).mockResolvedValueOnce({ status: 400 })
    expect(await f.run()).toBe("failed")
    const row = await f.row()
    await prisma.eventConsumerDelivery.update({ where: { id: row.id }, data: { status: "pending", attempts: 0 } })
    vi.mocked(f.transport.reconcile).mockResolvedValueOnce({ status: "unknown" })
    expect(await f.run()).toBe("failed")
    expect(f.transport.send).toHaveBeenCalledTimes(1)
    expect(f.transport.reconcile).toHaveBeenCalledWith(row.prepared, expect.any(AbortSignal))
    expect(await f.row()).toMatchObject({ error: { code: "reconciliation_required" } })
  })
  it("stops a permanent failure and blocks later events", async () => {
    const f = await setup()
    await prisma.domainEvent.create({ data: { organizationId: f.organizationId, sequence: 2, aggregateType: "invoice",
      aggregateId: "second", type: f.event.type, schemaVersion: 1, payload: f.event.payload!, actorKind: "system" } })
    vi.mocked(f.transport.send).mockResolvedValue({ status: 400 })
    expect(await f.run()).toBe("failed")
    expect(await f.run(new Date(f.now.getTime() + 86400000))).toBe("failed")
    expect(await f.row()).toMatchObject({ status: "failed", attempts: 1, error: { code: "http_400" } })
    expect(f.transport.send).toHaveBeenCalledTimes(1)
  })
  it("pauses disconnected orgs without scanning or contacting transport", async () => {
    const f = await setup()
    expect(await deliverAccounting({ organizationId: f.organizationId, clock: () => f.now,
      connections: { find: async () => null }, transport: f.transport })).toBe("paused")
    expect(await prisma.eventConsumerDelivery.count({ where: { organizationId: f.organizationId } })).toBe(0)
    expect(f.transport.send).not.toHaveBeenCalled()
  })
  it("records an adapter refusal without sending incomplete payments", async () => {
    const f = await setup("payment.recorded")
    const settings = await f.connection.settings()
    delete settings.payment
    expect(await f.run()).toBe("failed")
    expect(await f.row()).toMatchObject({ error: { code: "missing_mapping" } })
    expect(f.transport.send).not.toHaveBeenCalled()
  })
  it("reconciles a lost response without repeating the remote effect", async () => {
    const f = await setup()
    vi.mocked(f.transport.send).mockRejectedValueOnce(new Error("sensitive response must not be stored"))
    expect(await f.run()).toBe("pending")
    const row = await f.row()
    expect(row.error).toEqual({ code: "transport_error" })
    vi.mocked(f.transport.reconcile).mockResolvedValueOnce({ status: "delivered", externalRef: "recovered", totals: { net: "1", tax: "0.25", gross: "1.25" } })
    expect(await f.run(row.availableAt)).toBe("delivered")
    expect(f.transport.send).toHaveBeenCalledTimes(1)
    expect(await f.row()).toMatchObject({ externalRef: "recovered", attempts: 2 })
  })
  it("fails safely when an uncertain request cannot be reconciled", async () => {
    const f = await setup()
    vi.mocked(f.transport.send).mockRejectedValueOnce(new Error("timeout"))
    await f.run()
    vi.mocked(f.transport.reconcile).mockResolvedValueOnce({ status: "unknown" })
    expect(await f.run((await f.row()).availableAt)).toBe("failed")
    expect(await f.row()).toMatchObject({ error: { code: "reconciliation_required" } })
    expect(f.transport.send).toHaveBeenCalledTimes(1)
  })
  it("sends the e-conomic adapter's draft without booking it", async () => {
    const f = await setup(), invoice = invoiceFixture()
    const connections = { find: async () => ({ key: "economic-1", mappingRevision: "1", provider: economicProvider,
      settings: async () => ({ customerNumber: 42, layoutNumber: 1, paymentTermsNumber: 3,
        vatMappings: { [invoice.vatGroups[0]!.key]: { productNumber: "sales", vatZoneNumber: 1 } } }),
      request: (prepared: Extract<ReturnType<typeof economicProvider.map>, { status: "prepared" }>) => ({ path: "/invoices/drafts", body: prepared.payload }) }) }
    expect(await deliverAccounting({ organizationId: f.organizationId, connections, transport: f.transport, clock: () => f.now })).toBe("delivered")
    expect(f.transport.send).toHaveBeenCalledWith(expect.objectContaining({ providerId: "economic", path: "/invoices/drafts",
      body: expect.objectContaining({ customer: { customerNumber: 42 } }) }), expect.any(AbortSignal))
  })
  it("honors Retry-After and stops after five transient attempts", async () => {
    const f = await setup()
    vi.mocked(f.transport.send).mockResolvedValue({ status: 429, retryAfterMs: 120000 })
    let now = f.now
    for (let attempt = 1; attempt <= 5; attempt++) {
      expect(await f.run(now)).toBe(attempt === 5 ? "failed" : "pending")
      const row = await f.row()
      if (attempt < 5) expect(row.availableAt.getTime() - now.getTime()).toBe(120000)
      now = row.availableAt
    }
    expect(await f.row()).toMatchObject({ status: "failed", attempts: 5, error: { code: "http_429" } })
    expect(f.transport.send).toHaveBeenCalledTimes(5)
  })
  it("reclaims an expired final lease and fences a stale completion", async () => {
    const f = await setup()
    vi.mocked(f.transport.send).mockImplementationOnce(async () => {
      const row = await f.row()
      expect(await f.run(new Date(f.now.getTime() + 1))).toBe("idle")
      await prisma.eventConsumerDelivery.update({ where: { id: row.id }, data: { claimToken: "other-worker", leaseUntil: f.now, attempts: 5 } })
      return { status: 201, externalRef: "accepted", totals: { net: "1", tax: "0.25", gross: "1.25" } }
    })
    expect(await f.run()).toBe("stale")
    vi.mocked(f.transport.reconcile).mockResolvedValueOnce({ status: "delivered", externalRef: "accepted", totals: { net: "1", tax: "0.25", gross: "1.25" } })
    expect(await f.run(new Date(f.now.getTime() + 120001))).toBe("delivered")
    expect(await f.row()).toMatchObject({ status: "done", attempts: 6, externalRef: "accepted" })
    expect(f.transport.send).toHaveBeenCalledTimes(1)
  })
  it("isolates identical connection keys across organizations", async () => {
    const a = await setup(), b = await setup()
    expect(await a.run()).toBe("delivered")
    expect(await prisma.eventConsumerDelivery.count({ where: { organizationId: b.organizationId } })).toBe(0)
    expect(await b.run()).toBe("delivered")
    expect((await a.row()).id).not.toBe((await b.row()).id)
    expect(a.transport.send).toHaveBeenCalledTimes(1)
    expect(b.transport.send).toHaveBeenCalledTimes(1)
  })
})
