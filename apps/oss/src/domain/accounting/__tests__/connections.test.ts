import { describe, expect, it, vi } from "vitest"
import type { PrismaClient } from "../../../../generated/prisma/client"
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
