import { afterEach, describe, expect, it } from "vitest"
import { prisma } from "../../../lib/db"
import { createTestOrganization, hasTestDatabase } from "../../../test-utils/organization"
import { appRouter } from "../../router"

const describeIfDatabase = hasTestDatabase ? describe : describe.skip

describeIfDatabase("draft numbers in the app API", () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.()
  })

  async function setup() {
    const org = await createTestOrganization()
    cleanups.push(org.cleanup)
    const caller = appRouter.createCaller({
      session: {
        user: { id: org.actors.admin.userId, email: "admin@example.com", name: "Admin" },
        session: { activeOrganizationId: org.organizationId },
      },
    } as never)
    const contact = await prisma.contact.create({
      data: { organizationId: org.organizationId, name: "Acme", email: "billing@acme.test" },
    })
    return { org, caller, contact }
  }

  it("shows a draft invoice without a number and the number it would take, which is not reserved", async () => {
    const { org, caller, contact } = await setup()
    await prisma.orgSettings.update({ where: { organizationId: org.organizationId }, data: { invoicePrefix: "FAK", invoiceNextNum: 42 } })
    const created = await caller.invoices.create({
      contactId: contact.id, dueDate: "2099-01-01", taxRate: 0, items: [{ description: "Work", quantity: 1, unitPrice: 100 }],
    })
    expect(created.number).toBeNull()

    const detail = await caller.invoices.get({ id: created.id })
    expect(detail).toMatchObject({ number: null, status: "draft", nextNumber: "FAK-0042" })
    const [listed] = await caller.invoices.list()
    expect(listed).toMatchObject({ id: created.id, number: null })
    // Previewing reserved nothing.
    expect((await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: org.organizationId } })).invoiceNextNum).toBe(42)
  })

  it("shows a draft quote without a number and the number it would take", async () => {
    const { org, caller, contact } = await setup()
    await prisma.orgSettings.update({ where: { organizationId: org.organizationId }, data: { quotePrefix: "TIL", quoteNextNum: 7 } })
    const created = await caller.quotes.create({
      contactId: contact.id, expiryDate: "2099-01-01", taxRate: 0, items: [{ description: "Work", quantity: 1, unitPrice: 100 }],
    })
    expect(created.number).toBeNull()
    expect(await caller.quotes.get({ id: created.id })).toMatchObject({ number: null, nextNumber: "TIL-0007" })
  })

  it("does not offer a preview for a document that already has a number", async () => {
    const { caller, contact } = await setup()
    const created = await caller.invoices.create({
      contactId: contact.id, dueDate: "2099-01-01", taxRate: 0, items: [{ description: "Work", quantity: 1, unitPrice: 100 }],
    })
    await prisma.invoice.update({ where: { id: created.id }, data: { number: "INV-0099" } })
    expect(await caller.invoices.get({ id: created.id })).toMatchObject({ number: "INV-0099", nextNumber: null })
  })
})
