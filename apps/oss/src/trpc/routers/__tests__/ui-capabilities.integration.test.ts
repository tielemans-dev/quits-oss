import { afterEach, describe, expect, it } from "vitest"
import { createTestOrganization, hasTestDatabase } from "../../../test-utils/organization"
import { appRouter } from "../../router"

const describeIfDatabase = hasTestDatabase ? describe : describe.skip

/**
 * The UI hides recurring, credit note, and reminder controls from roles the server would reject.
 * These capability flags must agree with the permissions the matching mutations enforce.
 */
describeIfDatabase("UI capability flags", () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.()
  })

  async function callers() {
    const org = await createTestOrganization({ roles: ["admin", "member", "accountant"] })
    cleanups.push(org.cleanup)
    const callerFor = (userId: string) =>
      appRouter.createCaller({
        session: {
          user: { id: userId, email: `${userId}@example.com`, name: userId },
          session: { activeOrganizationId: org.organizationId },
        },
      } as never)
    return {
      admin: callerFor(org.actors.admin.userId),
      member: callerFor(org.actors.member.userId),
      accountant: callerFor(org.actors.accountant.userId),
    }
  }

  it("reports recurring schedule rights per role", async () => {
    const { admin, member, accountant } = await callers()
    expect(await admin.recurring.capabilities()).toEqual({ canCreate: true, canUpdate: true })
    expect(await member.recurring.capabilities()).toEqual({ canCreate: true, canUpdate: true })
    expect(await accountant.recurring.capabilities()).toEqual({ canCreate: false, canUpdate: false })
  })

  it("reports credit note rights per role", async () => {
    const { admin, member, accountant } = await callers()
    expect(await admin.creditNotes.capabilities()).toEqual({ canCreate: true, canSend: true })
    expect(await member.creditNotes.capabilities()).toEqual({ canCreate: true, canSend: true })
    expect(await accountant.creditNotes.capabilities()).toEqual({ canCreate: false, canSend: false })
  })

  it("reports reminder rights per role, with the policy reserved for admins", async () => {
    const { admin, member, accountant } = await callers()
    expect(await admin.reminders.capabilities()).toEqual({
      canSendNow: true,
      canPause: true,
      canUpdatePolicy: true,
    })
    expect(await member.reminders.capabilities()).toEqual({
      canSendNow: true,
      canPause: true,
      canUpdatePolicy: false,
    })
    expect(await accountant.reminders.capabilities()).toEqual({
      canSendNow: false,
      canPause: false,
      canUpdatePolicy: false,
    })
    await expect(member.reminders.updatePolicy({ enabled: true, offsetsDays: [3] })).rejects.toThrow()
  })
})
