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
  const [row] = await prisma.$queryRaw<Array<{ count: number; waiterPids: number[] | null }>>`
    SELECT count(*)::int AS count, (array_agg(pid ORDER BY pid))[1:16] AS "waiterPids"
    FROM pg_stat_activity
    WHERE ${blocker} = ANY(pg_blocking_pids(pid))`
  try {
    expect(row.count).toBe(0)
  } catch (assertionError) {
    // Keep the failed observation, even if waiters disappear before this later snapshot.
    // Only fixed query-kind labels and PostgreSQL lock identities may leave the database.
    const evidence = {
      holderPid: blocker, immediateCount: row.count, countedWaiterPids: row.waiterPids,
      waiterPidsTruncated: row.count > 16, laterSnapshot: "unavailable" as unknown,
    }
    try {
      const snapshot = await prisma.$transaction(async tx => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`
        await tx.$executeRaw`SELECT set_config('statement_timeout', '500ms', true)`
        return tx.$queryRaw<Array<{ evidence: unknown }>>`
          WITH involved AS (
            SELECT pid, pg_blocking_pids(pid) AS blockers,
              CASE
                WHEN left(query, 128) ~* '^[[:space:]]*CREATE[[:space:]]+(UNIQUE[[:space:]]+)?INDEX[[:space:]]+CONCURRENTLY([[:space:]]|$)'
                  THEN 'create-index-concurrently'
                WHEN left(query, 128) ~* '^[[:space:]]*SELECT[[:space:]]+pg_advisory_[a-z_]+[[:space:]]*[(]'
                  THEN 'select-advisory-lock'
                WHEN left(query, 128) ~* '^[[:space:]]*SELECT([[:space:]]|$)' THEN 'select-redacted'
                ELSE 'other-redacted'
              END AS query_kind
            FROM pg_stat_activity
            WHERE pid = ${blocker} OR pid = ANY(${row.waiterPids ?? []}::int[])
          ), relevant_locks AS (
            SELECT l.* FROM pg_locks l JOIN involved i USING (pid)
          ), bounded_locks AS (
            SELECT * FROM relevant_locks
            ORDER BY granted, pid, locktype, mode, database, relation, page, tuple,
              virtualxid, transactionid::text, classid, objid, objsubid
            LIMIT 128
          )
          SELECT jsonb_build_object(
            'backends', (SELECT coalesce(jsonb_agg(jsonb_build_object(
              'pid', pid, 'pgBlockingPids', blockers, 'queryKind', query_kind
            ) ORDER BY pid), '[]'::jsonb) FROM involved),
            'lockCount', (SELECT count(*) FROM relevant_locks),
            'locks', (SELECT coalesce(jsonb_agg(jsonb_build_object(
              'pid', pid, 'locktype', locktype, 'mode', mode, 'granted', granted,
              'identity', jsonb_build_object(
                'database', database, 'relation', relation, 'page', page, 'tuple', tuple,
                'virtualxid', virtualxid, 'transactionid', transactionid::text,
                'classid', classid, 'objid', objid, 'objsubid', objsubid
              )
            )), '[]'::jsonb) FROM bounded_locks)
          ) AS evidence`
      }, { maxWait: 250, timeout: 1_500 })
      evidence.laterSnapshot = snapshot[0]?.evidence
    } catch {
      // Error messages can include SQL or connection details. Never print them.
    }
    try {
      console.error("[advisory-waiters-diagnostic]", JSON.stringify(evidence))
    } catch { /* Logging must not replace the original assertion failure either. */ }
    throw assertionError
  }
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
