import { randomUUID } from "node:crypto"
import { afterEach, describe, expect, it } from "vitest"
import { prisma } from "../../../lib/db"
import { createTestOrganization, hasTestDatabase } from "../../../test-utils/organization"
import { appRouter } from "../../router"

// Seed read models deliberately: commands and financial effects have separate integration coverage.
// Cross-tenant links below are permitted by simple FKs, so scoped reads must still exclude them.
describe.skipIf(!hasTestDatabase)("receipt history bulk reads", () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => { while (cleanups.length) await cleanups.pop()?.() })

  it("preserves exact attribution and complete sequence-ordered history for one and 82 mixed receipts", async () => {
    const org = await createTestOrganization()
    cleanups.push(org.cleanup)
    const other = await createTestOrganization()
    cleanups.push(other.cleanup)
    const userId = org.actors.admin.userId
    const caller = appRouter.createCaller({ session: {
      user: { id: userId, name: userId, email: `${userId}@example.test` },
      session: { activeOrganizationId: org.organizationId },
    } } as never)
    const contact = await caller.contacts.create({ name: "Selected customer" })
    const otherContact = await caller.contacts.create({ name: "Other customer" })
    const foreignContact = await prisma.contact.create({ data: { organizationId: other.organizationId, name: "Other tenant" } })
    const invoice = await caller.invoices.create({ contactId: contact.id, dueDate: "2099-01-01",
      items: [{ description: "Work", quantity: 1, unitPrice: 1000 }] })
    const recordedAt = new Date("2026-01-01T12:00:00Z")
    const verifiedAt = new Date("2026-01-02T12:00:00Z")
    const later = new Date("2026-01-03T12:00:00Z")
    const ids: string[] = Array.from({ length: 84 }, () => randomUUID())
    const receipt = (index: number) => ({ id: ids[index]!,
      organizationId: index === 83 ? other.organizationId : org.organizationId,
      contactId: index === 83 ? foreignContact.id : index === 82 ? otherContact.id : contact.id,
      currency: "DKK", grossAmount: "100", netAmount: "98", feeAmount: "2",
      feeReason: "Bank fee", feeEvidence: "fee:statement",
      paidAt: recordedAt, createdAt: recordedAt, method: "bank_transfer", reference: ids[index]!,
      reason: "Original receipt", evidence: "original:statement", actorKey: "user:recorder", commandId: randomUUID(),
      reversedAt: index === 1 || index === 2 ? later : null,
    })
    await prisma.settlementReceipt.create({ data: receipt(0) })
    async function source(current: number | null, tenant = org.organizationId, pending = false) {
      const row = await prisma.settlementEvidenceSource.create({ data: {
        organizationId: tenant, contactId: tenant === org.organizationId ? contact.id : foreignContact.id,
        source: "bank", accountReference: "synthetic-account", transactionReference: randomUUID(),
        receiptId: current === null ? null : ids[current], revision: 10,
      } })
      const observation = await prisma.settlementEvidence.create({ data: {
        sourceId: row.id, revision: 1, eventReference: randomUUID(), state: pending ? "returned" : "received",
        occurredAt: verifiedAt, currency: "DKK", netAmount: "98", feeAmount: "2",
        feeReason: "Bank fee", feeEvidence: "fee:statement",
        reason: "Original source", evidence: "source:statement", payloadHash: "synthetic-read-fixture",
        actorKey: "user:source", commandId: randomUUID(), createdAt: verifiedAt,
      } })
      return { sourceId: row.id, evidenceId: observation.id }
    }
    async function decision(link: Awaited<ReturnType<typeof source>>, index: number,
      action = "match", actorKey = "user:verifier", createdAt = verifiedAt, revision = 1) {
      return prisma.settlementEvidenceDecision.create({ data: {
        ...link, receiptId: ids[index]!, action, actorKey, createdAt, revision,
        reason: "Reviewed identity", evidence: "decision:identity", commandId: randomUUID(),
      } })
    }
    const verified = await source(0)
    await decision(verified, 0, "confirm", "user:older", recordedAt, 1)
    await decision(verified, 0, "match", "user:tie-lower-revision", verifiedAt, 2)
    await decision(verified, 0, "match", "user:latest", verifiedAt, 3)
    const expected = new Map<string, Array<{ id: string; type: string; actorKind: string; actorId: string;
      occurredAt: Date; commandId: string; payload: { receiptId: string; action: string } }>>()
    let sequence = 10000
    async function history(index: number, length: number) {
      const rows = Array.from({ length }, (_, n) => ({ id: randomUUID(), organizationId: org.organizationId,
        sequence: sequence++, aggregateType: "receipt", aggregateId: ids[index]!, type: "settlement.changed",
        // Occurrence time deliberately runs backwards; sequence defines immutable history order.
        actorKind: "user", actorId: "historian", occurredAt: new Date(later.getTime() - n * 1000),
        commandId: randomUUID(), payload: { receiptId: ids[index]!, action: n ? "reverse_allocation" : "record_receipt" },
      }))
      await prisma.domainEvent.createMany({ data: [...rows].reverse() })
      expected.set(ids[index]!, rows.map(({ id, type, actorKind, actorId, occurredAt, commandId, payload }) =>
        ({ id, type, actorKind, actorId, occurredAt, commandId, payload })))
    }
    await history(0, 121)
    const single = await caller.payments.receipts({ invoiceId: invoice.id })
    expect(single.receipts).toHaveLength(1)
    expect(single.receipts[0]!.provenance).toEqual({ state: "verified", recordedBy: "user:recorder",
      recordedAt: recordedAt.toISOString(), verifiedBy: "user:latest", verifiedAt: verifiedAt.toISOString() })
    expect(single.receipts[0]!.history).toEqual(expected.get(ids[0]!))

    await prisma.settlementReceipt.createMany({ data: Array.from({ length: 83 }, (_, n) => receipt(n + 1)) })
    await decision(await source(1), 1) // Reversed cash suppresses verification.
    await decision(await source(null, org.organizationId, true), 2, "return", "user:returner")
    await decision(await source(3, org.organizationId, true), 3) // Pending return is evidence, not applied cash return.
    const moved = await source(5)
    await decision(moved, 4, "match", "user:old-match", later, 1)
    await decision(moved, 5, "match", "user:rematcher", verifiedAt, 2)
    await decision(await source(null), 6) // Unmatched historical verification is retained but not current.
    // These malformed tenant links must not override current attribution or assert a return.
    const foreign = await source(0, other.organizationId)
    await decision(foreign, 0, "match", "user:foreign", later, 1)
    await decision(foreign, 7, "return", "user:foreign", later, 2)
    for (let index = 1; index < 84; index++) await history(index, 2)
    await prisma.domainEvent.createMany({ data: [
      { id: randomUUID(), organizationId: other.organizationId, sequence: 1, aggregateType: "receipt", aggregateId: ids[0]!,
        type: "settlement.changed", actorKind: "user", actorId: "foreign", payload: { receiptId: ids[0]!, action: "return" } },
      { id: randomUUID(), organizationId: org.organizationId, sequence: sequence++, aggregateType: "receipt", aggregateId: ids[0]!,
        type: "invoice.changed", actorKind: "user", actorId: "unrelated", payload: { receiptId: ids[0]! } },
    ] })
    const emptyContact = await caller.contacts.create({ name: "No receipts" })
    const emptyInvoice = await caller.invoices.create({ contactId: emptyContact.id, dueDate: "2099-01-01",
      items: [{ description: "Unpaid work", quantity: 1, unitPrice: 1000 }] })
    expect((await caller.payments.receipts({ invoiceId: emptyInvoice.id })).receipts).toEqual([])
    const before = await prisma.settlementEvidenceDecision.findMany({ where: { source: { organizationId: org.organizationId } }, orderBy: { id: "asc" } })
    const result = await caller.payments.receipts({ invoiceId: invoice.id })
    expect(result.receipts).toHaveLength(82)
    expect(new Set(result.receipts.map(row => row.id))).toEqual(new Set(ids.slice(0, 82)))
    const states = ["verified", "received", "returned", "received", "received", "verified", "received"]
    for (const row of result.receipts) {
      const index = ids.indexOf(row.id)
      expect(row.provenance).toEqual({ state: states[index] ?? "received", recordedBy: "user:recorder",
        recordedAt: recordedAt.toISOString(), verifiedBy: index === 0 ? "user:latest" : index === 5 ? "user:rematcher" : null,
        verifiedAt: index === 0 || index === 5 ? verifiedAt.toISOString() : null })
      expect(row.history).toEqual(expected.get(row.id))
      expect(row).toMatchObject({ gross: "100.00", fee: "2.00", net: "98.00", allocated: "0.00", refunded: "0.00",
        available: index === 1 || index === 2 ? "0.00" : "100.00", reversed: index === 1 || index === 2,
        customerCredit: false, allocations: [], refunds: [], reason: "Original receipt", evidence: "original:statement" })
    }
    expect(await prisma.settlementEvidenceDecision.findMany({ where: { source: { organizationId: org.organizationId } }, orderBy: { id: "asc" } })).toEqual(before)
    // Foreign decisions reference this tenant's receipts, so delete their organization first.
  })
})
