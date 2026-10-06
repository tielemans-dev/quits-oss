import { afterEach, describe, expect, it } from "vitest"
import { createTestOrganization, hasTestDatabase } from "../../../test-utils/organization"
import { ORGANIZATION_CHANGED_MESSAGE } from "../../init"
import { appRouter } from "../../router"

const describeIfDatabase = hasTestDatabase ? describe : describe.skip

function callerFor(organizationId: string, userId: string, requestedOrganizationId?: string | null) {
  return appRouter.createCaller({
    session: {
      user: { id: userId, email: `${userId}@test.yaip.invalid`, name: userId },
      session: { activeOrganizationId: organizationId },
    },
    requestedOrganizationId,
  } as never)
}

describeIfDatabase("requested organization check", () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.()
  })

  it("rejects a request made for another organization than the active one", async () => {
    const org = await createTestOrganization()
    cleanups.push(org.cleanup)
    const caller = callerFor(org.organizationId, org.actors.admin.userId, "org_switched_away")

    await expect(caller.contacts.list()).rejects.toMatchObject({
      code: "CONFLICT",
      message: ORGANIZATION_CHANGED_MESSAGE,
    })
    await expect(caller.contacts.create({ name: "Acme" })).rejects.toMatchObject({ code: "CONFLICT" })
  })

  it("accepts a request made for the active organization", async () => {
    const org = await createTestOrganization()
    cleanups.push(org.cleanup)

    await expect(
      callerFor(org.organizationId, org.actors.admin.userId, org.organizationId).contacts.list()
    ).resolves.toEqual([])
  })

  it("keeps accepting requests that do not name an organization", async () => {
    const org = await createTestOrganization()
    cleanups.push(org.cleanup)

    await expect(callerFor(org.organizationId, org.actors.admin.userId).contacts.list()).resolves.toEqual([])
    await expect(callerFor(org.organizationId, org.actors.admin.userId, null).contacts.list()).resolves.toEqual([])
  })

  it("never grants access to the organization the request names", async () => {
    const org = await createTestOrganization()
    cleanups.push(org.cleanup)
    const outsider = callerFor(org.organizationId, "not-a-member", org.organizationId)

    await expect(outsider.contacts.list()).rejects.toMatchObject({ code: "FORBIDDEN" })
  })
})
