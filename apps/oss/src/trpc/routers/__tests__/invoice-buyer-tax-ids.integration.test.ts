import { afterEach, describe, expect, it } from "vitest"
import { prisma } from "../../../lib/db"
import { createTestOrganization, hasTestDatabase } from "../../../test-utils/organization"
import { appRouter } from "../../router"

const describeIfDatabase = hasTestDatabase ? describe : describe.skip

describeIfDatabase("the buyer's numbers on the invoice page", () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.()
  })

  it("gives a draft the contact's CVR and an issued invoice the frozen one", async () => {
    const org = await createTestOrganization()
    cleanups.push(org.cleanup)
    const caller = appRouter.createCaller({
      session: {
        user: { id: org.actors.admin.userId, email: "admin@example.com", name: "Admin" },
        session: { activeOrganizationId: org.organizationId },
      },
    } as never)
    // The number sits only in the single tax ID field, as a CVR lookup fills it.
    const contact = await prisma.contact.create({
      data: { organizationId: org.organizationId, name: "Kunde ApS", email: "faktura@kunde.test", country: "DK", taxId: "DK 24256790" },
    })
    const created = await caller.invoices.create({
      contactId: contact.id, dueDate: "2099-01-01", taxRate: 0, items: [{ description: "Work", quantity: 1, unitPrice: 100 }],
    })
    expect((await caller.invoices.get({ id: created.id })).buyerTaxIds).toEqual([{ scheme: "cvr", value: "24256790", countryCode: "DK" }])

    const frozen = [{ scheme: "cvr", value: "10150817", countryCode: "DK" }]
    await prisma.invoice.update({ where: { id: created.id }, data: { status: "sent", number: "INV-0001", buyerSnapshot: { name: "Kunde ApS", taxIds: frozen } } })
    expect((await caller.invoices.get({ id: created.id })).buyerTaxIds).toEqual(frozen)
  })
})
