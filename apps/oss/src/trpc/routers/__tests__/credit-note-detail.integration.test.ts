import { afterEach, describe, expect, it } from "vitest"
import { createTestOrganization, hasTestDatabase } from "../../../test-utils/organization"
import { exportAccounting } from "../../../lib/exports/accounting"
import { prisma } from "../../../lib/db"
import { appRouter } from "../../router"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()?.() })

;(hasTestDatabase ? describe : describe.skip)("issued credit note detail", () => {
  it("loads the issued ID from both lists and preserves tenant isolation", async () => {
    // MOCK: test-only organization, buyer, invoice and credit note with synthetic amounts.
    const org = await createTestOrganization({ settings: { currency: "DKK" } })
    cleanups.push(org.cleanup)
    const caller = (organizationId: string, userId: string) => appRouter.createCaller({ session: {
      user: { id: userId, email: "test@example.test", name: "Test" },
      session: { activeOrganizationId: organizationId },
    } } as never)
    const api = caller(org.organizationId, org.actors.admin.userId)
    const contact = await api.contacts.create({ name: "Test buyer", email: "buyer@example.test" })
    const invoice = await api.invoices.createV2({ contactId: contact.id, dueDate: "2099-01-01", supplyDate: "2026-10-11", taxRate: "25",
      items: [{ description: "Work", quantity: "1", unitPrice: "100" }] })
    await api.invoices.send({ id: invoice.id, allowSendWithoutEmail: true })
    const issued = await api.creditNotes.issue({ invoiceId: invoice.id, mode: "full", reason: "Correction" })
    expect(issued.id).toMatch(/^doc_/)
    for (const list of [await api.creditNotes.list(), await api.creditNotes.list({ invoiceId: invoice.id })]) {
      expect(list[0]?.id).toBe(issued.id)
      expect(await api.creditNotes.get({ id: list[0]!.id })).toMatchObject({ id: issued.id, number: "CN-0001", total: 125 })
    }
    const other = await createTestOrganization()
    cleanups.push(other.cleanup)
    await expect(caller(other.organizationId, other.actors.admin.userId).creditNotes.get({ id: issued.id }))
      .rejects.toMatchObject({ code: "NOT_FOUND" })
  })
  it("keeps numbered drafts out of settlement, supports undo, and issues the same draft only on click", async () => {
    const org = await createTestOrganization({ settings: { currency: "DKK" } })
    cleanups.push(org.cleanup)
    const api = appRouter.createCaller({ session: { user: { id: org.actors.admin.userId }, session: { activeOrganizationId: org.organizationId } } } as never)
    const contact = await api.contacts.create({ name: "Draft buyer", email: "draft@example.test" })
    const invoice = await api.invoices.createV2({ contactId: contact.id, dueDate: "2099-01-01", supplyDate: "2026-10-11", taxRate: "25", items: [{ description: "Work", quantity: "3", unitPrice: "0.03" }] })
    await api.invoices.send({ id: invoice.id, allowSendWithoutEmail: true })
    const before = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })
    const selection = { invoiceId: invoice.id, mode: "lines" as const, reason: "Fejl i antal", lines: [{ invoiceItemId: invoice.items[0]!.id, quantity: 1 }] }
    const request = { selection, clientRequestId: crypto.randomUUID() }
    const draft = await api.creditNotes.createDraft(request)
    expect(await api.creditNotes.createDraft(request)).toEqual(draft)
    expect(await api.creditNotes.get(draft)).toMatchObject({ status: "draft", number: "CN-0001", subtotal: 0.03, taxAmount: 0.01, total: 0.04 })
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).toEqual(before)
    expect((await api.creditNotes.view(draft)).view).toMatchObject({ kind: "creditNote", state: "draft", number: { value: draft.number } })
    await expect(api.creditNotes.send(draft)).rejects.toThrow()
    const other = await createTestOrganization()
    cleanups.push(other.cleanup)
    const outsider = appRouter.createCaller({ session: { user: { id: other.actors.admin.userId }, session: { activeOrganizationId: other.organizationId } } } as never)
    expect(await outsider.creditNotes.findInvoice({ number: before.number! })).toBeNull()
    await expect(outsider.creditNotes.discardDraft(draft)).rejects.toThrow()
    await expect(outsider.creditNotes.issueDraft(draft)).rejects.toThrow()
    await api.creditNotes.discardDraft(draft)
    expect(await api.creditNotes.list()).toEqual([])
    expect((await exportAccounting(org.organizationId, { dataset: "creditNotes", from: "2026-01-01", to: "2026-12-31" })).csv).not.toContain(draft.number)
    await expect(api.creditNotes.issueDraft(draft)).rejects.toThrow()
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).toEqual(before)
    const stale = await api.creditNotes.createDraft({ selection: { invoiceId: invoice.id, mode: "full", reason: "Rabat" }, clientRequestId: crypto.randomUUID() })
    const next = await api.creditNotes.createDraft({ selection, clientRequestId: crypto.randomUUID() })
    expect(next.number).toBe("CN-0003")
    expect(await api.creditNotes.issueDraft(next)).toEqual(next)
    expect(await api.creditNotes.get(next)).toMatchObject({ status: "issued", total: 0.04, lastEmailAttemptAt: null })
    await expect(api.creditNotes.discardDraft(next)).rejects.toThrow()
    await expect(api.creditNotes.issueDraft(stale)).rejects.toThrow("remaining credit changed")
  })

})
