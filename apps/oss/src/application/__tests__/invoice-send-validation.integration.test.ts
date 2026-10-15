import { afterEach, describe, expect, it, vi } from "vitest"
vi.mock("../../lib/email", async () => ({ ...(await vi.importActual<typeof import("../../lib/email")>("../../lib/email")), deliver: vi.fn().mockResolvedValue({ id: "synthetic-send" }) }))
import { deliver } from "../../lib/email"
import { prisma } from "../../lib/db"
import { createTestOrganization, hasTestDatabase } from "../../test-utils/organization"
import { appRouter } from "../../trpc/router"
import { setRuntimeExtensions } from "../../lib/runtime/extensions"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()?.(); setRuntimeExtensions([]); vi.unstubAllEnvs(); vi.mocked(deliver).mockClear() })
async function setup(bank = true) {
  vi.stubEnv("RESEND_API_KEY", "synthetic-key")
  vi.stubEnv("FROM_EMAIL", "billing@example.test")
  vi.stubEnv("BETTER_AUTH_SECRET", "synthetic-test-auth-secret-over-32-characters")
  vi.stubEnv("QUITS_PUBLIC_PAYMENT_SECRET", "synthetic-test-payment-secret")
  const org = await createTestOrganization({ settings: { countryCode: "DK", locale: "da-DK", timezone: "Europe/Copenhagen", currency: "DKK", taxRegime: "eu_vat" } })
  cleanups.push(org.cleanup)
  await prisma.orgSettings.update({ where: { organizationId: org.organizationId }, data: { companyAddress: "Testvej 1, 1000 København" } })
  await prisma.organizationTaxId.create({ data: { organizationId: org.organizationId, scheme: "cvr", value: "12345678", countryCode: "DK", isPrimary: true } })
  const caller = appRouter.createCaller({ session: { user: { id: org.actors.admin.userId, email: "admin@example.test", name: "Synthetic Admin" }, session: { activeOrganizationId: org.organizationId } } } as never)
  if (bank) await caller.paymentDetails.update({ bankAccount: { regNumber: "0040", accountNumber: "0440116243" } })
  const contact = await prisma.contact.create({ data: { organizationId: org.organizationId, name: "Synthetic Buyer", company: "Synthetic Buyer ApS", address: "Testvej 2", zip: "1000", city: "København", country: "DK", email: "buyer@example.test" } })
  const create = () => caller.invoices.createV2({ contactId: contact.id, dueDate: "2099-01-01", supplyDate: "2098-12-31", taxRate: "25", items: [{ description: "Work", quantity: "1", unitPrice: "100", vat: { treatment: "standard", rate: "0.25", country: "DK" } }] })
  return { org, caller, contact, create }
}
;(hasTestDatabase ? describe : describe.skip)("invoice send validation and retries", () => {
  it("concurrent clicks and a later retry produce one email and one issuance", async () => {
    const { org, caller, create } = await setup()
    const invoice = await create()
    const results = await Promise.allSettled([caller.invoices.send({ id: invoice.id }), caller.invoices.send({ id: invoice.id })])
    expect(results.some(result => result.status === "fulfilled")).toBe(true)
    // A call that lands after delivery settled is refused like any send of an issued invoice.
    for (const result of results) if (result.status === "rejected") expect(result.reason).toMatchObject({ cause: { code: "not_draft" } })
    await expect(caller.invoices.send({ id: invoice.id })).rejects.toMatchObject({ cause: { code: "not_draft" } })
    expect(vi.mocked(deliver)).toHaveBeenCalledTimes(1)
    expect(await prisma.job.count({ where: { organizationId: org.organizationId, type: "email.deliver" } })).toBe(1)
    expect(await prisma.domainEvent.count({ where: { aggregateId: invoice.id, type: "invoice.issued" } })).toBe(1)
    expect(await prisma.domainEvent.count({ where: { aggregateId: invoice.id, type: "invoice.sent" } })).toBe(1)
  })
})
