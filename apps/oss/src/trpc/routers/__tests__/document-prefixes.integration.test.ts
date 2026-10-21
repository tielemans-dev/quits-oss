import "dotenv/config"
import { randomUUID } from "node:crypto"
import { afterAll, describe, expect, it } from "vitest"
import { prisma } from "../../../lib/db"
import { ensureTestMembership } from "../../../test-utils/membership"
import { cleanupTestOrganizations } from "../../../test-utils/organization"
import { appRouter } from "../../router"

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const createdOrganizationIds: string[] = []

async function createOrganization(prefixes: { invoicePrefix: string; creditNotePrefix: string }) {
  const organizationId = randomUUID()
  const userId = `prefixes-${organizationId.slice(0, 8)}`
  createdOrganizationIds.push(organizationId)
  await prisma.organization.create({
    data: { id: organizationId, name: "Prefix Org", slug: `prefixes-${organizationId}`, createdAt: new Date(), subscriptionStatus: "pro" },
  })
  await ensureTestMembership(organizationId, userId)
  await prisma.orgSettings.create({ data: { organizationId, locale: "en-US", ...prefixes } })
  const caller = appRouter.createCaller({
    session: { user: { id: userId, email: `${userId}@example.com`, name: "Prefix User" }, session: { activeOrganizationId: organizationId } },
  } as never)
  return { organizationId, caller }
}

describeIfDatabase("settings document prefixes", () => {
  afterAll(async () => {
    await cleanupTestOrganizations({ where: { id: { in: createdOrganizationIds } } })
  })

  it("refuses equal invoice and credit-note prefixes on the field that changed", async () => {
    const { organizationId, caller } = await createOrganization({ invoicePrefix: "INV", creditNotePrefix: "CN" })
    const refusal = await caller.settings.update({ invoicePrefix: "INV", creditNotePrefix: "INV" }).catch((error: unknown) => error)
    expect(refusal).toMatchObject({ message: "Invoices and credit notes need different prefixes, so their numbers can never be the same." })
    expect((refusal as { cause?: { fieldIssues?: unknown } }).cause?.fieldIssues).toEqual([{ code: "prefix.conflict", field: "creditNotePrefix", params: {} }])
    expect(await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId } })).toMatchObject({ invoicePrefix: "INV", creditNotePrefix: "CN" })
  })

  it("lets an organization that already has equal prefixes save other settings, and fix them", async () => {
    const { organizationId, caller } = await createOrganization({ invoicePrefix: "DOC", creditNotePrefix: "DOC" })
    await caller.settings.update({ invoicePrefix: "DOC", creditNotePrefix: "DOC", companyName: "Still Saves ApS" })
    await expect(caller.settings.update({ invoicePrefix: "BILL", creditNotePrefix: "BILL" })).rejects.toThrow("different prefixes")
    await caller.settings.update({ invoicePrefix: "DOC", creditNotePrefix: "CN" })
    expect(await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId } }))
      .toMatchObject({ companyName: "Still Saves ApS", invoicePrefix: "DOC", creditNotePrefix: "CN" })
  })

  it("refuses a credit-note prefix that earlier invoice numbers carry", async () => {
    const { organizationId, caller } = await createOrganization({ invoicePrefix: "INV", creditNotePrefix: "CN" })
    const contact = await prisma.contact.create({ data: { organizationId, name: "Prefix Buyer", email: "buyer@example.test" } })
    const invoice = await caller.invoices.create({ contactId: contact.id, dueDate: "2099-01-01", taxRate: 0, items: [{ description: "Work", quantity: 1, unitPrice: 100 }] })
    // Issued while invoices were still numbered FAK; the series has moved on to INV since.
    await prisma.invoice.update({ where: { id: invoice.id }, data: { status: "sent", number: "FAK-0001" } })

    const refusal = await caller.settings.update({ invoicePrefix: "INV", creditNotePrefix: "FAK" }).catch((error: unknown) => error)
    expect((refusal as { cause?: { fieldIssues?: unknown } }).cause?.fieldIssues).toEqual([{ code: "prefix.conflict", field: "creditNotePrefix", params: {} }])
    // Other settings still save while the prefixes stay as they are, and an unused prefix is accepted.
    await caller.settings.update({ invoicePrefix: "INV", creditNotePrefix: "CN", companyName: "Prefix ApS" })
    await caller.settings.update({ invoicePrefix: "INV", creditNotePrefix: "KN" })
    expect(await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId } })).toMatchObject({ companyName: "Prefix ApS", creditNotePrefix: "KN" })
  })
})
