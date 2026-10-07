import { afterEach, describe, expect, it } from "vitest"
import { createTestOrganization, hasTestDatabase } from "../../../test-utils/organization"
import { appRouter } from "../../router"

const describeIfDatabase = hasTestDatabase ? describe : describe.skip

function callerFor(organizationId: string, userId: string) {
  return appRouter.createCaller({
    session: {
      user: { id: userId, email: `${userId}@test.quits.invalid`, name: userId },
      session: { activeOrganizationId: organizationId },
    },
  } as never)
}

describeIfDatabase("role permissions", () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.()
  })

  it("lets accountants read but not create, send, or change settings", async () => {
    const org = await createTestOrganization({ roles: ["admin", "accountant"] })
    cleanups.push(org.cleanup)
    const accountant = callerFor(org.organizationId, org.actors.accountant.userId)

    await expect(accountant.invoices.list()).resolves.toEqual([])
    await expect(accountant.contacts.create({ name: "Acme" })).rejects.toMatchObject({ code: "FORBIDDEN" })
    await expect(
      accountant.invoices.create({ contactId: "x", dueDate: "2026-12-01", taxRate: 0, items: [] } as never)
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
    await expect(accountant.settings.update({ companyName: "Hijacked" } as never)).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
  })

  it("keeps the accounting export to admins and accountants", async () => {
    const org = await createTestOrganization({ roles: ["admin", "member", "accountant"] })
    cleanups.push(org.cleanup)
    const input = { dataset: "invoices", from: "2026-01-01", to: "2026-01-31" } as never

    await expect(
      callerFor(org.organizationId, org.actors.member.userId).exports.accounting(input)
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
    await expect(
      callerFor(org.organizationId, org.actors.accountant.userId).exports.accounting(input)
    ).resolves.toMatchObject({ csv: expect.any(String) })
  })

  it("denies template CRUD to members and accountants without manageTemplates", async () => {
    const org = await createTestOrganization({ roles: ["admin", "member", "accountant"] })
    cleanups.push(org.cleanup)
    const admin = callerFor(org.organizationId, org.actors.admin.userId)
    const template = await admin.agreements.createTemplate({ name: "Managed", termsMarkdown: "Terms" })
    for (const role of ["member", "accountant"] as const) {
      const api = callerFor(org.organizationId, org.actors[role].userId)
      await expect(api.agreements.createTemplate({ name: "Denied", termsMarkdown: "Terms" })).rejects.toMatchObject({ code: "FORBIDDEN" })
      await expect(api.agreements.updateTemplate({ id: template.id, name: "Denied" })).rejects.toMatchObject({ code: "FORBIDDEN" })
      await expect(api.agreements.deleteTemplate({ id: template.id })).rejects.toMatchObject({ code: "FORBIDDEN" })
      await expect(api.agreements.listTemplates()).resolves.toEqual(expect.any(Array))
    }
    await expect(admin.agreements.updateTemplate({ id: template.id, name: "Edited" })).resolves.toMatchObject({ name: "Edited" })
    await expect(admin.agreements.deleteTemplate({ id: template.id })).resolves.toEqual({ id: template.id })
  })

  it("rejects users who are not members of the active organization", async () => {
    const org = await createTestOrganization()
    cleanups.push(org.cleanup)
    const outsider = callerFor(org.organizationId, "not-a-member")

    await expect(outsider.contacts.list()).rejects.toMatchObject({ code: "FORBIDDEN" })
  })
})
