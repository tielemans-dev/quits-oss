import { afterEach, describe, expect, it, vi } from "vitest"
import { prisma } from "../../../lib/db"
import { setRuntimeExtensions } from "../../../lib/runtime/extensions"
import { ensureTestMembership } from "../../../test-utils/membership"
import { createTestOrganization, hasTestDatabase } from "../../../test-utils/organization"
import { appRouter } from "../../router"

;(hasTestDatabase ? describe : describe.skip)("settings.deleteOrganization", () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => { setRuntimeExtensions([]); while (cleanups.length) await cleanups.pop()?.() })

  async function setup() {
    const org = await createTestOrganization({ roles: ["admin", "member", "accountant"] })
    cleanups.push(org.cleanup)
    const { name } = await prisma.organization.findUniqueOrThrow({ where: { id: org.organizationId } })
    const caller = (role: "admin" | "member" | "accountant") => appRouter.createCaller({ session: {
      user: { id: org.actors[role].userId, email: `${role}@example.test`, name: role },
      session: { activeOrganizationId: org.organizationId },
    } } as never)
    const exists = async () => Boolean(await prisma.organization.findUnique({ where: { id: org.organizationId } }))
    return { org, name, caller, exists }
  }

  it("refuses members, accountants and a mistyped name", async () => {
    const { name, caller, exists } = await setup()
    for (const role of ["member", "accountant"] as const) {
      await expect(caller(role).settings.deleteOrganization({ confirmName: name })).rejects.toMatchObject({ code: "FORBIDDEN" })
    }
    await expect(caller("admin").settings.deleteOrganization({ confirmName: `${name} typo` })).rejects.toMatchObject({ code: "BAD_REQUEST" })
    expect(await exists()).toBe(true)
  })

  it("refuses when a distribution switches the capability off", async () => {
    const { name, caller, exists } = await setup()
    setRuntimeExtensions([{ id: "hide-deletion", resolveCapabilities: () => ({ organizationDeletion: { enabled: false } }) }])
    await expect(caller("admin").settings.deleteOrganization({ confirmName: name })).rejects.toMatchObject({ code: "FORBIDDEN" })
    expect(await exists()).toBe(true)
  })

  it("purges at once without an extension and sends the admin to their other organization", async () => {
    const { org, name, caller, exists } = await setup()
    const other = await createTestOrganization()
    cleanups.push(other.cleanup)
    await ensureTestMembership(other.organizationId, org.actors.admin.userId, "member")
    await expect(caller("admin").settings.deleteOrganization({ confirmName: ` ${name} ` }))
      .resolves.toEqual({ status: "deleted", nextOrganizationId: other.organizationId })
    expect(await exists()).toBe(false)
    expect(await prisma.user.findUnique({ where: { id: org.actors.member.userId } })).toBeNull()
    expect(await prisma.user.findUnique({ where: { id: org.actors.admin.userId } })).not.toBeNull()
  })

  it("lets an extension replace the purge", async () => {
    const { org, name, caller, exists } = await setup()
    const deleteAfter = new Date("2099-01-08T00:00:00Z")
    const requestOrganizationDeletion = vi.fn(async () => ({ status: "scheduled" as const, deleteAfter }))
    setRuntimeExtensions([{ id: "scheduled-deletion", requestOrganizationDeletion }])
    await expect(caller("admin").settings.deleteOrganization({ confirmName: name }))
      .resolves.toEqual({ status: "scheduled", deleteAfter, nextOrganizationId: null })
    expect(requestOrganizationDeletion).toHaveBeenCalledWith({ organizationId: org.organizationId, userId: org.actors.admin.userId })
    expect(await exists()).toBe(true)
  })
})
