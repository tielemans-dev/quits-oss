import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import { prisma } from "../../lib/db"
import { canonicalizeOffer } from "../agreements/snapshot"
import { recordPublicLinkAttempt } from "../../lib/public-links/rate-limit"
import { createTestOrganization, hasTestDatabase } from "../../test-utils/organization"
import { actorKey } from "../actor"
import { createContact } from "../commands/contacts"
import { executeCommand } from "../execute"
import { acquireBoundedAdvisoryLock } from "../../lib/transaction-timeouts"

const describeWithDatabase = hasTestDatabase ? describe : describe.skip

async function withHeldLock(key: string, work: (pid: number) => Promise<void>) {
  let release!: () => void
  let locked!: (pid: number) => void
  const released = new Promise<void>(resolve => { release = resolve })
  const ready = new Promise<number>(resolve => { locked = resolve })
  const holder = prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`
    const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`
    locked(row.pid)
    await released
  }, { timeout: 15_000 })
  try {
    const pid = await Promise.race([ready, holder.then(() => { throw new Error("Lock holder ended early") })])
    await work(pid)
  } finally {
    release()
    await holder
  }
}

async function expectNoWaiters(blocker: number) {
  const [row] = await prisma.$queryRaw<Array<{ count: number }>>`
    SELECT count(*)::int AS count FROM pg_stat_activity
    WHERE ${blocker} = ANY(pg_blocking_pids(pid))`
  expect(row.count).toBe(0)
}

describeWithDatabase("server-side advisory lock bounds", () => {
  it("restores the configured row-lock timeout after advisory admission", async () => {
    await prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT set_config('lock_timeout', '7s', true)`
      await acquireBoundedAdvisoryLock(tx, randomUUID())
      const [row] = await tx.$queryRaw<Array<{ value: string }>>`SELECT current_setting('lock_timeout') AS value`
      expect(row.value).toBe("7s")
    })
  })

  it("does not apply the admission deadline to a later organization row lock", async () => {
    const org = await createTestOrganization()
    let release!: () => void
    let ready!: () => void
    const unlocked = new Promise<void>(resolve => { release = resolve })
    const locked = new Promise<void>(resolve => { ready = resolve })
    const holder = prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM org_settings WHERE "organizationId" = ${org.organizationId} FOR UPDATE`
      ready()
      await unlocked
    }, { timeout: 15_000 })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([locked, holder.then(() => { throw new Error("Row holder ended early") })])
      timer = setTimeout(release, 3500)
      const result = await executeCommand(createContact, { name: "Row lock fixture" }, {
        actor: org.actors.admin, clientRequestId: randomUUID(),
      })
      expect(result.status).toBe("completed")
    } finally {
      clearTimeout(timer)
      release()
      try { await holder } finally { await org.cleanup() }
    }
  })

  it("aborts a blocked command without side effects, then permits an idempotent retry", async () => {
    const org = await createTestOrganization()
    const clientRequestId = randomUUID()
    const options = { actor: org.actors.admin, clientRequestId }
    const key = `${org.organizationId}|${actorKey(options.actor)}|${clientRequestId}`
    try {
      await withHeldLock(key, async pid => {
        const start = performance.now()
        await expect(executeCommand(createContact, { name: "Timeout fixture" }, options)).rejects.toThrow(/lock timeout/i)
        expect(performance.now() - start).toBeLessThan(8_000)
        await expectNoWaiters(pid)
        expect(await prisma.contact.count({ where: { organizationId: org.organizationId } })).toBe(0)
        expect(await prisma.commandReceipt.count({ where: { organizationId: org.organizationId } })).toBe(0)
      })
      expect((await executeCommand(createContact, { name: "Timeout fixture" }, options)).status).toBe("completed")
      expect((await executeCommand(createContact, { name: "Timeout fixture" }, options)).status).toBe("completed")
      expect(await prisma.contact.count({ where: { organizationId: org.organizationId } })).toBe(1)
    } finally { await org.cleanup() }
  })

  it("ends a blocked public-link admission on the server and leaves its counter unchanged", async () => {
    const identity = { documentKind: "agreement" as const, documentId: randomUUID(), scope: "accept",
      keyVersion: 1, targetId: null, revision: 1 }
    try {
      await withHeldLock(canonicalizeOffer(identity), async pid => {
        await expect(recordPublicLinkAttempt(identity)).rejects.toThrow(/lock timeout/i)
        await expectNoWaiters(pid)
        expect(await prisma.publicLinkAttempt.count({ where: identity })).toBe(0)
      })
      await recordPublicLinkAttempt(identity)
      expect(await prisma.publicLinkAttempt.count({ where: identity })).toBe(1)
    } finally { await prisma.publicLinkAttempt.deleteMany({ where: identity }) }
  })
})
