import { afterEach, describe, expect, it } from "vitest"
import { createTestOrganization, hasTestDatabase } from "../../../test-utils/organization"
import { appRouter } from "../../router"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()?.() })

;(hasTestDatabase ? describe : describe.skip)("issued credit note detail", () => {
  it("loads the issued ID from both lists and preserves tenant isolation", async () => {
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
})
