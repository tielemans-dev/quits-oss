// Synthetic transaction reads; the real command handlers enforce reuse and undo policy.
import { Effect } from "effect"
import { expect, it, vi } from "vitest"
import type { Prisma } from "../../../../generated/prisma/client"
import { Command, Db, type CommandScope } from "../../services"
import { createContact, undoCreateContact } from "../contacts"
const contact = { id: "buyer", name: "Saved", taxId: "DK 24256790" }
const now = new Date("2026-10-15T12:00:00Z")
const scope: CommandScope = { actor: { kind: "user", organizationId: "org", userId: "member", roles: ["member"], label: "Member" }, organizationId: "org", commandId: "cmd", now, approvedByUserId: null, emit: vi.fn(), enqueue: vi.fn() }
function run<A, E>(effect: Effect.Effect<A, E, Db | Command>, db: unknown) {
  return Effect.runPromise(Effect.either(effect.pipe(Effect.provideService(Db, db as Prisma.TransactionClient), Effect.provideService(Command, scope))))
}
it("reuses a normalized CVR in this organization without creating or emitting", async () => {
  const db = { contact: { findMany: vi.fn().mockResolvedValue([contact]), create: vi.fn() } }
  expect(await run(createContact.handle({ name: "New registry name", country: "DK", taxId: "24256790", reuseCvr: true }), db)).toMatchObject({ _tag: "Right", right: { id: "buyer", reused: true } })
  expect(db.contact.findMany).toHaveBeenCalledWith({ where: { organizationId: "org", taxId: { not: null } } })
  expect(db.contact.create).not.toHaveBeenCalled()
})
it("creates a new contact with existing validation and strips the reuse option", async () => {
  const db = { contact: { findMany: vi.fn().mockResolvedValue([]), create: vi.fn().mockResolvedValue(contact) }, orgSettings: { findUnique: vi.fn().mockResolvedValue({ countryCode: "DK" }) } }
  expect(await run(createContact.handle({ name: "New", country: "DK", taxId: "24256790", reuseCvr: true }), db)).toMatchObject({ _tag: "Right", right: { reused: false } })
  expect(db.contact.create).toHaveBeenCalledWith({ data: { name: "New", country: "DK", taxId: "24256790", email: null, organizationId: "org" } })
})
const created = { type: "contact.created", actorKind: "user", actorId: "member", occurredAt: now }
function undoDb(event = created, documents = 0) {
  return { domainEvent: { findFirst: vi.fn().mockResolvedValue(event) }, contact: { findFirst: vi.fn().mockResolvedValue({ ...contact, _count: { invoices: documents } }), delete: vi.fn().mockResolvedValue(contact) } }
}
it("allows a member to undo only their own recent unused customer", async () => {
  const db = undoDb()
  expect(await run(undoCreateContact.handle({ id: "buyer" }), db)).toMatchObject({ _tag: "Right", right: { id: "buyer" } })
  expect(db.domainEvent.findFirst).toHaveBeenCalledWith({ where: { organizationId: "org", aggregateType: "contact", aggregateId: "buyer" }, orderBy: { sequence: "desc" } })
  expect(db.contact.delete).toHaveBeenCalledOnce()
})
it.each([{ ...created, actorId: "other" }, { ...created, occurredAt: new Date(now.getTime() - 8001) }, { ...created, type: "contact.updated" }])("refuses an unavailable undo", async event => {
  const db = undoDb(event)
  expect(await run(undoCreateContact.handle({ id: "buyer" }), db)).toMatchObject({ _tag: "Left", left: { code: "undo_unavailable" } })
  expect(db.contact.delete).not.toHaveBeenCalled()
})
it("never undoes a customer used by a saved invoice, even a draft", async () => {
  const db = undoDb(created, 1)
  expect(await run(undoCreateContact.handle({ id: "buyer" }), db)).toMatchObject({ _tag: "Left", left: { code: "contact_in_use" } })
  expect(db.contact.delete).not.toHaveBeenCalled()
})
