import { afterEach, describe, expect, it } from "vitest"
import { createTestOrganization, hasTestDatabase } from "../../../test-utils/organization"
import { appRouter } from "../../router"

const callerFor = (organizationId: string, userId: string) => appRouter.createCaller({
  session: { user: { id: userId, email: `${userId}@test.quits.invalid`, name: userId }, session: { activeOrganizationId: organizationId } },
} as never)

;(hasTestDatabase ? describe : describe.skip)("accounting integrations router", () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => { while (cleanups.length) await cleanups.pop()?.() })

  it("reports providers as not connected and lets only admins disconnect", async () => {
    const org = await createTestOrganization({ roles: ["admin", "member"] })
    cleanups.push(org.cleanup)
    const admin = callerFor(org.organizationId, org.actors.admin.userId)
    const member = callerFor(org.organizationId, org.actors.member.userId)

    await expect(admin.accounting.status()).resolves.toMatchObject({ canDisconnect: true,
      providers: [{ provider: "economic", status: "not_connected" }, { provider: "dinero", status: "not_connected" }] })
    await expect(member.accounting.status()).resolves.toMatchObject({ canDisconnect: false })
    await expect(member.accounting.disconnect()).rejects.toMatchObject({ code: "FORBIDDEN" })
    await expect(admin.accounting.disconnect()).resolves.toMatchObject({ canDisconnect: true })
  })
})
