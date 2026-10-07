import { afterEach, describe, expect, it, vi } from "vitest"
import { prisma } from "../../../lib/db"
import { listActivity, documentActivity } from "../../../lib/exports/activity"
import { createTestOrganization, hasTestDatabase } from "../../../test-utils/organization"
import { appendEvents, readActivity } from "../../events"
import type { AgentActor } from "../../actor"
import { activityTools } from "../../agent-tools/tools/activity"
import { advance, claim, complete, EventConsumerCursorConflict, fail, readEvents, scan } from "../consumers"
import type { EventType } from "../registry"
import { InvalidEvent } from "../registry"
import { UnsupportedEventVersion } from "../upcast"

const describeIfDatabase = hasTestDatabase ? describe : describe.skip

describeIfDatabase("event consumer outbox", () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => { while (cleanups.length) await cleanups.pop()?.() })
  async function setup(types: Array<"contact.created" | "contact.deleted"> = ["contact.created", "contact.created", "contact.created"]) {
    const org = await createTestOrganization()
    cleanups.push(org.cleanup)
    await prisma.$transaction((tx) => appendEvents(tx, {
      organizationId: org.organizationId, actor: org.actors.admin,
      commandId: null, approvedByUserId: null, occurredAt: new Date(),
      events: types.map((type) => ({ aggregateType: "contact", aggregateId: "contact-1", type, payload: { name: "Acme" } })),
    }))
    return { ...org, scope: { organizationId: org.organizationId, consumerKey: "bookkeeping" } }
  }
  async function scanned(types?: Array<"contact.created" | "contact.deleted">) {
    const org = await setup(types)
    await scan({ ...org.scope, interestedTypes: ["contact.created"], limit: 100 })
    return org
  }
  const take = (scope: { organizationId: string; consumerKey: string }, now = new Date()) => claim({ ...scope, limit: 100, leaseMs: 1000, now })

  it("failed N followed by done N+1 and N+2 leaves acknowledgement at N-1", async () => {
    const { scope } = await scanned()
    const rows = await take(scope)
    expect(rows).toHaveLength(3)
    await fail({ deliveryId: rows[0].id, claimToken: rows[0].claimToken, error: { message: "remote failure" } })
    for (const row of rows.slice(1)) await complete({ deliveryId: row.id, claimToken: row.claimToken, externalRef: `remote-${row.sequence}` })
    expect(await advance(scope)).toMatchObject({ scannedSequence: 3, acknowledgedSequence: 0 })
  })

  it("skipped N followed by done N+1 acknowledges N+1", async () => {
    const { scope } = await scanned(["contact.deleted", "contact.created"])
    const [row] = await take(scope)
    expect(row.sequence).toBe(2)
    await complete({ deliveryId: row.id, claimToken: row.claimToken })
    expect(await advance(scope)).toMatchObject({ acknowledgedSequence: 2, scannedSequence: 2 })
  })

  it("advances through an empty filtered tail because scan persists skips", async () => {
    const { scope } = await scanned(["contact.created", "contact.deleted", "contact.deleted"])
    const [row] = await take(scope)
    await complete({ deliveryId: row.id, claimToken: row.claimToken })
    expect(await readEvents({ organizationId: scope.organizationId, afterSequence: 1, types: ["contact.created"], limit: 100 })).toEqual([])
    expect(await advance(scope)).toMatchObject({ acknowledgedSequence: 3, scannedSequence: 3 })
  })

  it("fences complete and fail from a stale worker after lease expiry and reclaim", async () => {
    const { scope } = await scanned(["contact.created"])
    const now = new Date()
    const [old] = await take(scope, now)
    expect(await take(scope, new Date(now.getTime() + 999))).toEqual([])
    const [current] = await take(scope, new Date(now.getTime() + 1000))
    expect(current.id).toBe(old.id)
    expect(current.claimToken).not.toBe(old.claimToken)
    expect(current.attempts).toBe(2)
    expect(await complete({ deliveryId: old.id, claimToken: old.claimToken, externalRef: "stale" })).toEqual({ fenced: true })
    expect(await fail({ deliveryId: old.id, claimToken: old.claimToken, error: { stale: true } })).toEqual({ fenced: true })
    expect(await prisma.eventConsumerDelivery.findUniqueOrThrow({ where: { id: old.id } })).toMatchObject({ status: "claimed", claimToken: current.claimToken, externalRef: null, error: null })
    expect(await complete({ deliveryId: current.id, claimToken: current.claimToken, externalRef: "valid" })).toEqual({ fenced: false })
    expect(await fail({ deliveryId: current.id, claimToken: current.claimToken, error: {} })).toEqual({ fenced: true })
  })

  it("two concurrent workers never both claim the same pending row", async () => {
    const { scope } = await scanned()
    const now = new Date()
    const [a, b] = await Promise.all([take(scope, now), take(scope, now)])
    expect(a.length + b.length).toBe(3)
    expect(new Set([...a, ...b].map((row) => row.id)).size).toBe(3)
    expect(await prisma.eventConsumerDelivery.count({ where: { ...scope, status: "claimed", attempts: 1 } })).toBe(3)
  })

  it("recovers a crash after remote success by looking up the stable delivery id", async () => {
    const { scope } = await scanned(["contact.created"])
    const now = new Date()
    const remote = new Map<string, string>()
    const [first] = await take(scope, now)
    remote.set(first.id, "voucher-123") // Remote succeeded, process crashed before local complete.
    const [retry] = await take(scope, new Date(now.getTime() + 1001))
    expect(retry.id).toBe(first.id)
    const persisted = await prisma.eventConsumerDelivery.findUniqueOrThrow({ where: { id: retry.id } })
    expect(persisted).toMatchObject({ sequence: 1, organizationId: scope.organizationId })
    expect(await complete({ deliveryId: retry.id, claimToken: retry.claimToken, externalRef: remote.get(retry.id) })).toEqual({ fenced: false })
    expect(remote.size).toBe(1)
    expect(await advance(scope)).toMatchObject({ acknowledgedSequence: 1 })
  })

  it("reports a scan CAS conflict and rolls back inserted deliveries, then retries safely", async () => {
    const { scope } = await setup()
    await expect(prisma.$transaction(async (tx) => {
      vi.spyOn(tx.eventConsumerCursor, "updateMany").mockResolvedValueOnce({ count: 0 })
      return scan({ ...scope, interestedTypes: ["contact.created"], limit: 100 }, tx)
    })).rejects.toBeInstanceOf(EventConsumerCursorConflict)
    expect(await prisma.eventConsumerDelivery.count({ where: scope })).toBe(0)
    expect(await prisma.eventConsumerCursor.count({ where: scope })).toBe(0)
    expect(await scan({ ...scope, interestedTypes: ["contact.created"], limit: 100 })).toMatchObject({ scannedSequence: 3, acknowledgedSequence: 0 })
  })

  it("scanning twice leaves existing deliveries and their stable ids untouched", async () => {
    const { scope } = await scanned()
    const before = await prisma.eventConsumerDelivery.findMany({ where: scope, orderBy: { sequence: "asc" } })
    await take(scope)
    const current = await scan({ ...scope, interestedTypes: [], limit: 100 })
    expect(current).toMatchObject({ scannedSequence: 3, version: 1 })
    const after = await prisma.eventConsumerDelivery.findMany({ where: scope, orderBy: { sequence: "asc" } })
    expect(after.map((row) => row.id)).toEqual(before.map((row) => row.id))
    expect(after.map((row) => row.status)).toEqual(["claimed", "claimed", "claimed"])
  })

  it("reports an advance CAS conflict without corrupting either position", async () => {
    const { scope } = await scanned(["contact.deleted"])
    await expect(prisma.$transaction(async (tx) => {
      vi.spyOn(tx.eventConsumerCursor, "updateMany").mockResolvedValueOnce({ count: 0 })
      return advance(scope, tx)
    })).rejects.toBeInstanceOf(EventConsumerCursorConflict)
    expect(await prisma.eventConsumerCursor.findFirstOrThrow({ where: scope })).toMatchObject({ acknowledgedSequence: 0, scannedSequence: 1, version: 1 })
    expect(await advance(scope)).toMatchObject({ acknowledgedSequence: 1, version: 2 })
  })

  it("does not advance through missing, pending or claimed delivery rows", async () => {
    const { scope } = await scanned()
    expect(await advance(scope)).toMatchObject({ acknowledgedSequence: 0 })
    await take(scope)
    expect(await advance(scope)).toMatchObject({ acknowledgedSequence: 0 })
    await prisma.eventConsumerDelivery.deleteMany({ where: { ...scope, sequence: 1 } })
    await prisma.eventConsumerDelivery.updateMany({ where: scope, data: { status: "done" } })
    expect(await advance(scope)).toMatchObject({ acknowledgedSequence: 0 })
  })

  it("bounded scans use unfiltered order and concurrent scans preserve unique deliveries", async () => {
    const { scope } = await setup(["contact.deleted", "contact.created", "contact.deleted"])
    await scan({ ...scope, interestedTypes: ["contact.created"], limit: 1 })
    expect(await advance(scope)).toMatchObject({ acknowledgedSequence: 1, scannedSequence: 1 })
    const outcomes = await Promise.allSettled([scan({ ...scope, interestedTypes: ["contact.created"], limit: 100 }), scan({ ...scope, interestedTypes: ["contact.created"], limit: 100 })])
    expect(outcomes.some((outcome) => outcome.status === "fulfilled")).toBe(true)
    for (const outcome of outcomes) if (outcome.status === "rejected") expect(outcome.reason).toBeInstanceOf(EventConsumerCursorConflict)
    expect(await prisma.eventConsumerDelivery.count({ where: scope })).toBe(3)
    expect(await prisma.eventConsumerCursor.findFirstOrThrow({ where: scope })).toMatchObject({ acknowledgedSequence: 1, scannedSequence: 3 })
  })

  it("returns schemaVersion in both activity readers, document activity and the agent activity tool", async () => {
    const org = await setup()
    const query = { organizationId: org.organizationId }
    for (const page of [await readActivity(query), await listActivity(query)]) {
      expect(page.events).toHaveLength(3)
      expect(page.events.every((event) => event.schemaVersion === 1)).toBe(true)
    }
    const tool = activityTools.find((tool) => tool.name === "activity_read")!
    const actor: AgentActor = { kind: "agent", organizationId: org.organizationId, agentKeyId: "synthetic-key", label: "Fixture", mode: "read_only", scopes: ["audit:read"], ownerRoles: ["admin"] }
    const output = await tool.run({ actor }, {})
    expect(output).toMatchObject({ events: [ { schemaVersion: 1 }, { schemaVersion: 1 }, { schemaVersion: 1 } ] })
    await prisma.$transaction((tx) => appendEvents(tx, {
      organizationId: org.organizationId, actor: org.actors.admin, commandId: null, approvedByUserId: null, occurredAt: new Date(),
      events: [{ aggregateType: "invoice", aggregateId: "invoice-1", type: "invoice.sent", payload: { number: "INV-1", recipient: null, emailSent: false } }],
    }))
    expect((await documentActivity({ ...query, documentType: "invoice", documentId: "invoice-1" })).events).toMatchObject([{ schemaVersion: 1, type: "invoice.sent" }])
    expect((await readEvents({ ...query, afterSequence: 0, limit: 2, upcast: true })).map((event) => [event.sequence, event.schemaVersion])).toEqual([[1, 1], [2, 1]])
    await prisma.domainEvent.updateMany({ where: { ...query, sequence: 1 }, data: { schemaVersion: 2 } })
    await expect(readEvents({ ...query, afterSequence: 0, limit: 2, upcast: true })).rejects.toBeInstanceOf(UnsupportedEventVersion)
    expect((await readEvents({ ...query, afterSequence: 0, limit: 2 }))[0].schemaVersion).toBe(2)
  })

  it("rejects invalid append envelopes before changing the sequence, and enforces the SQL version check", async () => {
    const org = await setup([])
    const args = { organizationId: org.organizationId, actor: org.actors.admin, commandId: null, approvedByUserId: null, occurredAt: new Date() }
    await expect(prisma.$transaction((tx) => appendEvents(tx, { ...args, events: [{ aggregateType: "contact", aggregateId: "1", type: "contact.created", payload: { name: 1 } }] }))).rejects.toBeInstanceOf(InvalidEvent)
    await expect(prisma.$transaction((tx) => appendEvents(tx, { ...args, events: [{ aggregateType: "contact", aggregateId: "1", type: "unknown.type" as EventType, payload: {} }] }))).rejects.toMatchObject({ name: "InvalidEvent", reason: "unregistered" })
    expect(await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: org.organizationId } })).toMatchObject({ eventSequence: 0 })
    await expect(prisma.domainEvent.create({ data: { organizationId: org.organizationId, sequence: 1, aggregateType: "contact", aggregateId: "1", type: "contact.created", payload: { name: "Acme" }, schemaVersion: 0, actorKind: "system" } })).rejects.toThrow()
  })
})
