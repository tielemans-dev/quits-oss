import { afterEach, describe, expect, it } from "vitest"
import { prisma } from "../../../lib/db"
import { createTestOrganization, hasTestDatabase } from "../../../test-utils/organization"
import { clearLearnedPaymentTerms, loadLearnedPaymentTerms, restoreLearnedPaymentTerms } from "../learned-defaults-store"

const describeIfDatabase = hasTestDatabase ? describe : describe.skip
const DAY = 86_400_000

describeIfDatabase("learned payment terms", () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => { while (cleanups.length) await cleanups.pop()?.() })

  async function setup() {
    const org = await createTestOrganization({ roles: ["admin"] })
    cleanups.push(org.cleanup)
    await prisma.orgSettings.update({ where: { organizationId: org.organizationId }, data: { paymentTermsDays: 30 } })
    const contact = await prisma.contact.create({ data: { organizationId: org.organizationId, name: "Buyer" } })
    const invoice = (days: number, index: number, extra: { status?: string } = {}) => {
      const issued = new Date(Date.UTC(2026, 8, 1 + index, 10))
      return prisma.invoice.create({ data: {
        organizationId: org.organizationId, contactId: contact.id, status: extra.status ?? "sent", timezone: "UTC",
        issueDate: issued, dueDate: new Date(Date.UTC(2026, 8, 1 + index) + days * DAY), subtotalNet: 100, totalGross: 100,
      } })
    }
    return { org, contact, invoice }
  }

  it("learns after the same terms on the last two invoices, ignoring drafts", async () => {
    const { org, contact, invoice } = await setup()
    await invoice(14, 0)
    expect(await loadLearnedPaymentTerms(org.organizationId, contact.id)).toBeNull()
    await invoice(14, 1)
    await invoice(8, 2, { status: "draft" })
    expect(await loadLearnedPaymentTerms(org.organizationId, contact.id)).toEqual({ days: 14, count: 2 })
    await invoice(30, 3)
    expect(await loadLearnedPaymentTerms(org.organizationId, contact.id)).toBeNull()
  })

  it("keeps a cleared default cleared until Fortryd or a different value", async () => {
    const { org, contact, invoice } = await setup()
    await invoice(14, 0)
    await invoice(14, 1)
    expect(await clearLearnedPaymentTerms(org.organizationId, contact.id)).toEqual({ cleared: true })
    expect(await loadLearnedPaymentTerms(org.organizationId, contact.id)).toBeNull()
    await restoreLearnedPaymentTerms(org.organizationId, contact.id)
    expect(await loadLearnedPaymentTerms(org.organizationId, contact.id)).toEqual({ days: 14, count: 2 })
    await clearLearnedPaymentTerms(org.organizationId, contact.id)
    await invoice(8, 2)
    await invoice(8, 3)
    expect(await loadLearnedPaymentTerms(org.organizationId, contact.id)).toEqual({ days: 8, count: 2 })
  })

  it("never reads or writes another organization's customer", async () => {
    const a = await setup()
    const b = await setup()
    await a.invoice(14, 0)
    await a.invoice(14, 1)
    await expect(loadLearnedPaymentTerms(b.org.organizationId, a.contact.id)).rejects.toThrow()
    await expect(clearLearnedPaymentTerms(b.org.organizationId, a.contact.id)).rejects.toThrow()
    await expect(restoreLearnedPaymentTerms(b.org.organizationId, a.contact.id)).rejects.toThrow()
    expect(await loadLearnedPaymentTerms(b.org.organizationId, b.contact.id)).toBeNull()
  })
})
