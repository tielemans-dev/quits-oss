import { Effect } from "effect"
import { Command, Db, type CommandScope } from "../../services"
import { retryAccountingDelivery } from "../../commands/accounting"
import { describe, expect, it, vi } from "vitest"
import type { Prisma, PrismaClient } from "../../../../generated/prisma/client"
import { accountingConnections, connectAccounting } from "../connections"
import { accountFingerprint } from "../sync-position"
import { defaultMappings } from "../mappings"
import { creditFixture } from "./fixtures"

vi.mock("../../../lib/secrets", () => ({ encryptSecret: () => "synthetic-ciphertext" }))

describe("accounting connection evidence", () => {
  it.each([false, true])("attributes connection and held-delivery audits to the actor, reconnect=%s", async reconnect => {
    const actor = { kind: "user" as const, organizationId: "org", userId: "admin", roles: ["admin" as const], label: "Admin" }
    const previous = { provider: "dinero", remoteAccountId: "remote", generation: "old" }
    const createMany = vi.fn(), update = vi.fn()
    const tx = { accountingConnection: { findUnique: async () => reconnect ? previous : null, upsert: vi.fn() },
      eventConsumerDelivery: { findMany: async () => [{ id: "pending", error: null }, { id: "claimed", error: null }], update },
      orgSettings: { upsert: async () => ({ eventSequence: reconnect ? 3 : 1 }) }, domainEvent: { createMany } }
    const db = { $transaction: async (work: (db: unknown) => Promise<void>) => work(tx) } as unknown as PrismaClient
    await connectAccounting({ actor, organizationId: "org", provider: "dinero", remoteAccountId: "remote", credential: "synthetic", mappingRevision: "1" }, db)
    const events = createMany.mock.calls[0][0].data
    expect(events).toHaveLength(reconnect ? 3 : 1)
    for (const event of events) expect(event).toMatchObject({ type: "accounting.action_recorded", actorKind: "user", actorId: "admin", actorLabel: "Admin" })
    expect(events.at(-1).payload.action).toBe(reconnect ? "reconnect" : "connect")
    if (reconnect) {
      expect(update).toHaveBeenCalledTimes(2)
      expect(events.slice(0, 2).map((event: { payload: unknown }) => event.payload)).toEqual(["pending", "claimed"].map(deliveryId => ({ action: "reconnect_hold", provider: "dinero", generation: "old", deliveryId, reason: "reconnect_review_required" })))
    }
    expect(JSON.stringify(events)).not.toContain("synthetic")
  })

  it("finds a connection with corrupt stored mappings but blocks new preparation", async () => {
    const db = { accountingConnection: { findFirst: async () => ({ provider: "dinero", mappings: { rows: [{ ...defaultMappings().rows[0], revenueAccount: -1 }], paymentAccount: null } }) } } as unknown as PrismaClient
    const runtime = { settings: vi.fn(), transport: vi.fn() }
    const connection = await accountingConnections(runtime, db).find("org")
    expect(connection!.record.invalidMappingRows).toEqual([0])
    await expect(connection!.settings({ id: "event", deliveryId: "d", type: "invoice.issued", schemaVersion: 1, payload: {} })).rejects.toThrow()
    expect(runtime.settings).not.toHaveBeenCalled()
  })
  it.each(["A", "B"])("restores the latest attempted %s row after three alternating-account reconnects", async currentAccount => {
    // A -> B -> A -> B, or B -> A -> B -> A. The flattened pointer still names the first row.
    const otherAccount = currentAccount === "A" ? "B" : "A"
    const fingerprint = (remoteAccountId: string) => accountFingerprint({ provider: "dinero", remoteAccountId })
    const history = [otherAccount, currentAccount, otherAccount].map((account, i) => ({
      id: `old-${i}`, sequence: 1, consumerKey: `accounting:dinero:g${i}`, organizationId: "org",
      error: { code: "reconnect_review_required", accountFingerprint: fingerprint(account), previousDeliveryId: "old-0" },
      evidence: { hash: `source-${i}` }, prepared: { idempotencyKey: `request-${i}` },
      externalRef: `draft-${i}`, response: { externalRef: `draft-${i}` },
    }))
    const current = { id: "current", sequence: 1, error: { code: "reconnect_review_required", previousDeliveryId: "old-0" } }
    const findFirst = vi.fn(async ({ where }: { where: { id?: string; error?: { equals: string } } }) =>
      where.id ? current : [...history].reverse().find(row => row.error.accountFingerprint === where.error?.equals))
    const updateMany = vi.fn(async () => ({ count: 1 }))
    const db = { accountingConnection: { findFirst: async () => ({ provider: "dinero", generation: "current", remoteAccountId: currentAccount }) },
      eventConsumerDelivery: { findFirst, updateMany } } as unknown as Prisma.TransactionClient
    const scope: CommandScope = { organizationId: "org", commandId: "cmd", now: new Date(), approvedByUserId: null,
      actor: { kind: "system", organizationId: "org", reason: "migration", label: "Test" }, emit: vi.fn(), enqueue: vi.fn() }
    await Effect.runPromise(retryAccountingDelivery.handle({ deliveryId: "current", confirmReconnect: true }).pipe(
      Effect.provideService(Db, db), Effect.provideService(Command, scope)))
    expect(findFirst).toHaveBeenLastCalledWith(expect.objectContaining({ where: expect.objectContaining({ organizationId: "org", sequence: 1,
      consumerKey: { startsWith: "accounting:dinero:", not: "accounting:dinero:current" }, error: { path: ["accountFingerprint"], equals: fingerprint(currentAccount) } }) }))
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      prepared: history[1]!.prepared, evidence: history[1]!.evidence, externalRef: "draft-1", response: history[1]!.response, status: "pending", attempts: 0,
    }) }))
  })
  it("resolves a credit with its invoice's saved configuration after mappings change", async () => {
    const mappings = defaultMappings(), original = { mappingRevision: "1", mappings: structuredClone(mappings) }
    mappings.rows[0]!.revenueAccount = 2000
    const stored = { organizationId: "org", generation: "new", provider: "dinero", remoteAccountId: "remote", mappingRevision: "2", mappings }
    const saved = { ...original, accountFingerprint: accountFingerprint(stored) }
    const findFirstOrThrow = vi.fn(async () => ({ prepared: saved }))
    const db = { accountingConnection: { findFirst: async () => stored }, domainEvent: { findFirstOrThrow: async () => ({ sequence: 1 }) },
      eventConsumerDelivery: { findFirstOrThrow } } as unknown as PrismaClient
    const runtime = { settings: vi.fn(), transport: vi.fn() }, connection = (await accountingConnections(runtime, db).find("org"))!
    const credit = { id: "credit-event", deliveryId: "credit-delivery", type: "credit_note.issued", schemaVersion: 2, payload: creditFixture() }
    const mapping = await connection.resolveMapping(credit)
    await connection.settings(credit, mapping)
    expect(runtime.settings).toHaveBeenCalledWith(expect.objectContaining(original), credit)
    expect(findFirstOrThrow).toHaveBeenCalledWith(expect.objectContaining({ where: { organizationId: "org", sequence: 1, status: "done", consumerKey: { startsWith: "accounting:dinero:" }, prepared: { path: ["accountFingerprint"], equals: saved.accountFingerprint } } }))
  })
})
