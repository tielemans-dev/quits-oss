import "dotenv/config"
import { randomUUID } from "node:crypto"
import { afterEach, describe, expect, it } from "vitest"
import { Client } from "pg"
import { prisma } from "../../lib/db"
import { createTestOrganization, hasTestDatabase } from "../../test-utils/organization"
import { overdueOrganizations } from "../features/overdue"
import { reminderOrganizations } from "../features/reminders"
import { registerJobHandler, runDueJobs, TerminalJobError } from "../jobs"
import { Prisma } from "../../../generated/prisma/client"
import {
  forEachOrganizationWithinBudget,
  scannedOrganizationSource,
  type ClaimOptions,
  type OrganizationSource,
} from "../scheduler"

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
const describeIfDatabase = hasTestDatabase ? describe : describe.skip

/** An in-memory source with the same contract as `scannedOrganizationSource`. */
function sourceOf(organizationIds: string[]): OrganizationSource {
  const scannedAt = new Map<string, number | null>(organizationIds.map((id) => [id, null]))
  let clock = 0
  const order = (id: string) => scannedAt.get(id) ?? -Infinity
  return {
    count: async () => organizationIds.length,
    claim: async (limit) => {
      const claimed = [...organizationIds]
        .sort((a, b) => order(a) - order(b) || a.localeCompare(b))
        .slice(0, limit)
      for (const id of claimed) scannedAt.set(id, (clock += 1))
      return {
        organizationIds: claimed,
        finish: async () => undefined,
        release: async (ids) => {
          for (const id of ids) scannedAt.set(id, null)
        },
      }
    },
  }
}

describe("forEachOrganizationWithinBudget", () => {
  it("reaches every organization when there are more than the budget allows", async () => {
    const organizationIds = Array.from({ length: 23 }, (_, index) => `org-${String(index).padStart(2, "0")}`)
    const budget = { maxOrganizations: 4, timeBudgetMs: 60_000 }
    const source = sourceOf(organizationIds)
    const visited = new Set<string>()

    for (let tick = 0; tick < Math.ceil(organizationIds.length / budget.maxOrganizations); tick += 1) {
      const result = await forEachOrganizationWithinBudget(
        source,
        async (organizationId) => {
          visited.add(organizationId)
        },
        budget
      )
      expect(result.processed).toBeLessThanOrEqual(budget.maxOrganizations)
    }

    expect([...visited].sort()).toEqual(organizationIds)
  })

  it("stops starting organizations once the time budget is used and releases the rest", async () => {
    const visited: string[] = []
    const source = sourceOf(["a", "b", "c"])
    const slow = async (organizationId: string) => {
      visited.push(organizationId)
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    const result = await forEachOrganizationWithinBudget(source, slow, { maxOrganizations: 10, timeBudgetMs: 5 })
    expect(visited).toEqual(["a"])
    expect(result).toEqual({ organizations: 3, processed: 1, deferred: 2 })

    // The released organizations go before the one that was reached.
    await forEachOrganizationWithinBudget(source, slow, { maxOrganizations: 2, timeBudgetMs: 60_000 })
    expect(visited).toEqual(["a", "b", "c"])
  })
})

describeIfDatabase("scheduler against the database", () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.()
  })

  async function organizationWithInvoices(
    invoices: Array<{ dueInDays: number; amountPaid?: number; status?: string }>,
    options: { email?: string; reminders?: boolean } = {}
  ) {
    const org = await createTestOrganization()
    cleanups.push(org.cleanup)
    if (options.reminders) {
      await prisma.orgSettings.update({
        where: { organizationId: org.organizationId },
        data: { reminderPolicy: { enabled: true, offsetsDays: [7] } },
      })
    }
    const contact = await prisma.contact.create({
      data: { organizationId: org.organizationId, name: "Acme", email: options.email ?? "billing@acme.test" },
    })
    await prisma.invoice.createMany({
      data: invoices.map((invoice) => ({
        organizationId: org.organizationId,
        contactId: contact.id,
        number: `INV-${randomUUID().slice(0, 8)}`,
        status: invoice.status ?? "sent",
        issueDate: new Date(Date.now() - 60 * DAY),
        dueDate: new Date(Date.now() + invoice.dueInDays * DAY),
        subtotalNet: 100,
        totalGross: 100,
        amountPaid: invoice.amountPaid ?? 0,
      })),
    })
    return org.organizationId
  }

  const LEASE: ClaimOptions = { leaseMs: 60_000, maxRegistrations: 100 }
  const claimAll = async (source: OrganizationSource) => (await source.claim(100, LEASE)).organizationIds

  /** A source over exactly these organizations under a task no other test uses. */
  function testSource(organizationIds: readonly string[]) {
    const task = `test.${randomUUID()}`
    const source = scannedOrganizationSource(
      task,
      Prisma.sql`SELECT "id" AS "organizationId" FROM "organization" WHERE "id" IN (${Prisma.join([...organizationIds])})`
    )
    const scans = () =>
      prisma.schedulerScan.findMany({ where: { task }, orderBy: { organizationId: "asc" } })
    return { task, source, scans }
  }

  it("selects overdue organizations in the database, ignoring settled invoices", async () => {
    const pastDue = await organizationWithInvoices([{ dueInDays: -5 }, { dueInDays: -10 }])
    const settled = await organizationWithInvoices([{ dueInDays: -5, amountPaid: 100 }])
    const notYetDue = await organizationWithInvoices([{ dueInDays: 5 }])
    const source = overdueOrganizations(new Date(), { organizationIds: [pastDue, settled, notYetDue] })

    expect(await source.count()).toBe(1)
    expect(await claimAll(source)).toEqual([pastDue])
  })

  it("selects reminder organizations with reminders on and an open invoice with a balance", async () => {
    const eligible = await organizationWithInvoices([{ dueInDays: -10 }, { dueInDays: -20 }], { reminders: true })
    const remindersOff = await organizationWithInvoices([{ dueInDays: -10 }])
    const settled = await organizationWithInvoices([{ dueInDays: -10, amountPaid: 100 }], { reminders: true })
    const noRecipient = await organizationWithInvoices([{ dueInDays: -10 }], { reminders: true, email: " " })
    const source = reminderOrganizations({ organizationIds: [eligible, remindersOff, settled, noRecipient] })

    expect(await source.count()).toBe(1)
    expect(await claimAll(source)).toEqual([eligible])
  })

  it("covers every overdue organization in successive ticks, whatever time the ticks pass", async () => {
    const organizationIds = await Promise.all(
      Array.from({ length: 5 }, () => organizationWithInvoices([{ dueInDays: -3 }]))
    )
    // Registers every organization on the first tick; bounded registration is tested below.
    const budget = { maxOrganizations: 2, timeBudgetMs: 60_000, maxRegistrations: organizationIds.length }
    const ticks = Math.ceil(organizationIds.length / budget.maxOrganizations)
    const startedAt = Date.now()

    // Identical, cadence-aliased (every 11 minutes) and out-of-order tick times all cover every
    // organization in ceil(5 / 2) ticks, because the rotation is kept in the database.
    for (const timeOf of [
      () => startedAt,
      (tick: number) => startedAt + tick * 11 * MINUTE,
      (tick: number) => startedAt + (ticks - tick) * DAY,
    ]) {
      const visited = new Set<string>()
      for (let tick = 0; tick < ticks; tick += 1) {
        await forEachOrganizationWithinBudget(
          overdueOrganizations(new Date(timeOf(tick)), { organizationIds }),
          async (organizationId) => {
            visited.add(organizationId)
          },
          budget
        )
      }
      expect([...visited].sort()).toEqual([...organizationIds].sort())
    }
  })

  it("lets concurrent ticks claim within their limit and still cover every organization", async () => {
    const organizationIds = await Promise.all(Array.from({ length: 4 }, () => organizationWithInvoices([])))
    const { source } = testSource(organizationIds)

    const [first, second] = await Promise.all([source.claim(2, LEASE), source.claim(2, LEASE)])
    expect(first.organizationIds.length).toBeLessThanOrEqual(2)
    expect(second.organizationIds.length).toBeLessThanOrEqual(2)
    expect(first.organizationIds.filter((id) => second.organizationIds.includes(id))).toEqual([])

    const claimed = new Set([...first.organizationIds, ...second.organizationIds])
    for (let tick = 0; tick < 2 && claimed.size < organizationIds.length; tick += 1) {
      for (const id of (await source.claim(2, LEASE)).organizationIds) claimed.add(id)
    }
    expect([...claimed].sort()).toEqual([...organizationIds].sort())
  })

  it("does not hand out organizations a live claim holds, and releases them to go first", async () => {
    const organizationIds = (await Promise.all(Array.from({ length: 3 }, () => organizationWithInvoices([])))).sort()
    const { source } = testSource(organizationIds)

    const first = await source.claim(2, LEASE)
    expect(first.organizationIds).toEqual(organizationIds.slice(0, 2))
    // Only the unclaimed organization is left while the first claim is live.
    const second = await source.claim(3, LEASE)
    expect(second.organizationIds).toEqual(organizationIds.slice(2))
    expect((await source.claim(3, LEASE)).organizationIds).toEqual([])

    // Finished organizations become claimable again; released ones go first.
    await first.finish([organizationIds[0]!])
    await first.release([organizationIds[1]!])
    expect((await source.claim(1, LEASE)).organizationIds).toEqual([organizationIds[1]])
    expect((await source.claim(1, LEASE)).organizationIds).toEqual([organizationIds[0]])
  })

  // A database clock can repeat a millisecond or move backwards. A persisted frontier ahead
  // of the current clock makes that ordering deterministic without replacing production SQL
  // or its clock. Equal stamps retain the observed organization-ID tie-break.
  async function seedQueueFrontier(task: string, organizationIds: readonly string[]) {
    await prisma.$executeRaw`
      INSERT INTO "scheduler_scan" ("task", "organizationId", "scannedAt")
      SELECT ${task}, "id", (statement_timestamp() AT TIME ZONE 'UTC') + INTERVAL '1 day'
      FROM "organization" WHERE "id" IN (${Prisma.join([...organizationIds])})
    `
    const [row] = await prisma.schedulerScan.findMany({ where: { task }, take: 1 })
    return row!.scannedAt!
  }

  it("advances past a tied queue frontier and restores released organizations before finished ones", async () => {
    const organizationIds = (await Promise.all(Array.from({ length: 2 }, () => organizationWithInvoices([])))).sort()
    const { task, source, scans } = testSource(organizationIds)
    const frontier = await seedQueueFrontier(task, organizationIds)
    expect((await scans()).map((row) => row.scannedAt)).toEqual([frontier, frontier])

    const claim = await source.claim(2, { ...LEASE, maxRegistrations: 0 })
    expect(claim.organizationIds).toEqual(organizationIds)
    const claimed = await scans()
    // Advancing the queue must not move lease expiry a day into the future.
    expect(claimed.every((row) => row.claimedUntil!.getTime() < frontier.getTime())).toBe(true)
    expect((await source.claim(2, LEASE)).organizationIds).toEqual([])

    await claim.finish([organizationIds[0]!])
    await claim.release([organizationIds[1]!])
    expect((await scans())[1]).toMatchObject({ scannedAt: frontier, claimToken: null, claimedUntil: null })
    expect((await source.claim(1, LEASE)).organizationIds).toEqual([organizationIds[1]])
    expect(claimed.every((row) => row.scannedAt!.getTime() > frontier.getTime())).toBe(true)
  })

  it("queues bounded registrations after the queue frontier and serves newcomers and old scans", async () => {
    const organizationIds = (await Promise.all(Array.from({ length: 7 }, () => organizationWithInvoices([])))).sort()
    const { task, source, scans } = testSource(organizationIds)
    await seedQueueFrontier(task, organizationIds.slice(0, 2))
    const visited: string[][] = []
    for (let tick = 0; tick < 6; tick += 1) {
      const reached: string[] = []
      await forEachOrganizationWithinBudget(source, async (id) => void reached.push(id), {
        maxOrganizations: 3, timeBudgetMs: 60_000, maxRegistrations: 2,
      })
      visited.push(reached)
      expect((await scans()).length).toBe(Math.min(7, 2 + (tick + 1) * 2))
    }
    expect(visited[0]).toEqual(organizationIds.slice(0, 3))
    expect(new Set(visited.flat())).toEqual(new Set(organizationIds))
    expect(visited.flat().filter((id) => id === organizationIds[0]).length).toBeGreaterThan(1)
    expect((await scans()).every((row) => row.claimToken === null && row.claimedUntil === null)).toBe(true)
  })

  it("keeps concurrent claims disjoint at a tied queue frontier and preserves unreached places", async () => {
    const organizationIds = (await Promise.all(Array.from({ length: 6 }, () => organizationWithInvoices([])))).sort()
    const { task, source, scans } = testSource(organizationIds)
    const frontier = await seedQueueFrontier(task, organizationIds)
    const options = { ...LEASE, maxRegistrations: 0 }
    const claims = await Promise.all([source.claim(2, options), source.claim(2, options)])
    expect(claims.map((claim) => claim.organizationIds.length)).toEqual([2, 2])
    const claimedIds = claims.flatMap((claim) => claim.organizationIds)
    expect(new Set(claimedIds).size).toBe(4)
    expect(claimedIds.sort()).toEqual(organizationIds.slice(0, 4))
    const concurrentScans = await scans()

    const released = claims.map((claim) => claim.organizationIds[1]!)
    await Promise.all(claims.map(async (claim) => {
      await claim.finish([claim.organizationIds[0]!])
      await claim.release([claim.organizationIds[1]!])
    }))
    const waiting = [...released, ...organizationIds.slice(4)].sort()
    const next = await source.claim(4, options)
    expect(next.organizationIds).toEqual(waiting)
    expect(concurrentScans.filter((row) => row.claimToken).every((row) => row.scannedAt! > frontier)).toBe(true)
    const stillHeld = await source.claim(6, options)
    expect(stillHeld.organizationIds.sort()).toEqual(claims.map((claim) => claim.organizationIds[0]!).sort())
  })

  /** Pause the actual claim after its statement snapshot, before it locks candidates. */
  async function pausedSnapshotClaim(
    task: string,
    organizationIds: string[],
    intervening: () => Promise<void>,
    limit = organizationIds.length
  ) {
    const barrier = new Client({ connectionString: process.env.DATABASE_URL })
    await barrier.connect()
    let pending: ReturnType<OrganizationSource["claim"]> | undefined
    let key: number | undefined
    try {
      const result = await barrier.query<{ key: number }>('SELECT pg_backend_pid() AS key')
      key = result.rows[0]!.key
      await barrier.query('SELECT pg_advisory_lock(1729, $1)', [key])
      const gated = scannedOrganizationSource(task, Prisma.sql`
        SELECT "id" AS "organizationId" FROM "organization"
        CROSS JOIN (SELECT pg_advisory_xact_lock(1729, ${key}::integer)) gate
        WHERE "id" IN (${Prisma.join(organizationIds)})
      `)
      pending = gated.claim(limit, { ...LEASE, maxRegistrations: 0 })
      // Observe the SQL lock itself. No timing sleep, query mock or replaced clock.
      void pending.catch(() => undefined)
      let blocked = false
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const [row] = await prisma.$queryRaw<Array<{ blocked: boolean }>>`
          SELECT EXISTS (
            SELECT 1 FROM pg_locks WHERE locktype = 'advisory'
              AND classid = 1729::oid AND objid = ${key}::oid AND objsubid = 2 AND NOT granted
          ) AS blocked
        `
        if (row?.blocked) {
          blocked = true
          break
        }
      }
      expect(blocked).toBe(true)
      await intervening()
      await barrier.query('SELECT pg_advisory_unlock(1729, $1)', [key])
      return await pending
    } finally {
      if (key !== undefined) await barrier.query('SELECT pg_advisory_unlock(1729, $1)', [key])
      if (pending) await pending.catch(() => undefined)
      await barrier.end()
    }
  }

  it.each([1, 2])("advances the whole %i-row batch beyond newer locked rows after an older statement snapshot", async (size) => {
    const organizationIds = (await Promise.all(Array.from({ length: size }, () => organizationWithInvoices([])))).sort()
    const { task, source, scans } = testSource(organizationIds)
    await seedQueueFrontier(task, organizationIds)
    const newerId = organizationIds[size - 1]!
    const newer = scannedOrganizationSource(task, Prisma.sql`
      SELECT "id" AS "organizationId" FROM "organization" WHERE "id" = ${newerId}
    `)
    let prior: Awaited<ReturnType<typeof scans>> = []
    const resumed = await pausedSnapshotClaim(task, organizationIds, async () => {
      // Two completed production claims make the locked row newer than the snapshot's MAX + 1ms.
      for (let claimIndex = 0; claimIndex < 2; claimIndex += 1) {
        const current = await newer.claim(1, { ...LEASE, maxRegistrations: 0 })
        expect(current.organizationIds).toEqual([newerId])
        await current.finish([newerId])
      }
      prior = await scans()
    })
    expect(resumed.organizationIds).toEqual(organizationIds)
    const held = await scans()
    const latestPrior = Math.max(...prior.map((row) => row.scannedAt!.getTime()))
    expect(held.every((row) => row.scannedAt!.getTime() > latestPrior)).toBe(true)
    expect(held.every((row) => row.claimedUntil!.getTime() < latestPrior)).toBe(true)
    expect((await source.claim(size, { ...LEASE, maxRegistrations: 0 })).organizationIds).toEqual([])
    await resumed.finish(organizationIds.slice(0, -1))
    await resumed.release([newerId])
    expect((await scans()).find((row) => row.organizationId === newerId)).toEqual(
      prior.find((row) => row.organizationId === newerId)
    )
    // A finished lower-id batch member must queue behind the restored, newer prior place.
    expect((await source.claim(1, { ...LEASE, maxRegistrations: 0 })).organizationIds).toEqual([newerId])
  })

  it("queues a resumed finished claim behind a newer released row outside its locked batch", async () => {
    const organizationIds = (await Promise.all(Array.from({ length: 2 }, () => organizationWithInvoices([])))).sort()
    const { task, source, scans } = testSource(organizationIds)
    await seedQueueFrontier(task, organizationIds)
    const waitingId = organizationIds[1]!
    const other = scannedOrganizationSource(task, Prisma.sql`
      SELECT "id" AS "organizationId" FROM "organization" WHERE "id" = ${waitingId}
    `)
    const resumed = await pausedSnapshotClaim(task, organizationIds, async () => {
      const completed = await other.claim(1, { ...LEASE, maxRegistrations: 0 })
      await completed.finish([waitingId])
      const unreached = await other.claim(1, { ...LEASE, maxRegistrations: 0 })
      await unreached.release([waitingId])
    }, 1)
    expect(resumed.organizationIds).toEqual([organizationIds[0]])
    await resumed.finish(resumed.organizationIds)
    const rows = await scans()
    expect(rows[0]!.scannedAt!.getTime()).toBeGreaterThan(rows[1]!.scannedAt!.getTime())
    expect((await source.claim(1, { ...LEASE, maxRegistrations: 0 })).organizationIds).toEqual([waitingId])
  })

  it("lets a tick take over an expired claim, and the stale claim cannot undo it", async () => {
    const organizationId = await organizationWithInvoices([])
    const { source, scans } = testSource([organizationId])

    const stale = await source.claim(1, { ...LEASE, leaseMs: 0 })
    expect(stale.organizationIds).toEqual([organizationId])

    const current = await source.claim(1, LEASE)
    expect(current.organizationIds).toEqual([organizationId])
    const [taken] = await scans()
    expect(taken?.scannedAt).not.toBeNull()
    expect(taken?.claimedUntil?.getTime()).toBeGreaterThan(Date.now())

    // The stale claim's release and finish leave the newer claim and its scan time alone.
    await stale.release([organizationId])
    await stale.finish([organizationId])
    expect(await scans()).toEqual([taken])
    expect((await source.claim(1, LEASE)).organizationIds).toEqual([])

    await current.finish([organizationId])
    const [finished] = await scans()
    expect(finished).toMatchObject({ scannedAt: taken?.scannedAt, claimToken: null, claimedUntil: null })
  })

  it("registers a bounded number of newly eligible organizations per tick and still reaches all", async () => {
    const organizationIds = (await Promise.all(Array.from({ length: 7 }, () => organizationWithInvoices([])))).sort()
    const { source, scans } = testSource(organizationIds)
    const budget = { maxOrganizations: 3, timeBudgetMs: 60_000, maxRegistrations: 2 }
    const visited: string[][] = []

    for (let tick = 0; tick < 6; tick += 1) {
      const reached: string[] = []
      await forEachOrganizationWithinBudget(
        source,
        async (organizationId) => {
          reached.push(organizationId)
        },
        budget
      )
      visited.push(reached)
      // Registration is bounded per tick and goes in organization id order.
      expect((await scans()).map((scan) => scan.organizationId)).toEqual(
        organizationIds.slice(0, Math.min(organizationIds.length, (tick + 1) * budget.maxRegistrations))
      )
    }

    // Organizations are reached in the order they started waiting: newcomers queue behind
    // organizations scanned before they arrived, so neither newcomers nor existing ones starve.
    expect(visited[0]).toEqual(organizationIds.slice(0, 2))
    expect(visited[1]).toEqual(organizationIds.slice(0, 3))
    expect(new Set(visited.flat())).toEqual(new Set(organizationIds))
    expect((await scans()).every((scan) => scan.scannedAt && scan.claimToken === null)).toBe(true)
  })

  it("keeps revisiting existing organizations while newcomers keep arriving, even one per tick", async () => {
    const organizationIds = (await Promise.all(Array.from({ length: 6 }, () => organizationWithInvoices([])))).sort()
    const [existing, ...newcomers] = organizationIds
    let eligible = [existing!]
    // One task whose eligible set grows by a newcomer every tick.
    const { task } = testSource(organizationIds)
    const tick = () =>
      forEachOrganizationWithinBudget(
        scannedOrganizationSource(
          task,
          Prisma.sql`SELECT "id" AS "organizationId" FROM "organization" WHERE "id" IN (${Prisma.join(eligible)})`
        ),
        async (id) => void reached.push(id),
        { maxOrganizations: 1, timeBudgetMs: 60_000, maxRegistrations: 1 }
      )
    const reached: string[] = []

    for (const newcomer of newcomers) {
      await tick()
      eligible = [...eligible, newcomer!]
    }
    for (let index = 0; index < newcomers.length; index += 1) {
      await tick()
    }

    // The existing organization is reached again before every newcomer has been served.
    const revisit = reached.indexOf(existing!, 1)
    expect(revisit).toBeGreaterThan(0)
    expect(revisit).toBeLessThan(reached.length - 1)
  })

  describe("job sweep", () => {
    async function queueJobs(organizationId: string, type: string, attempts: number[]) {
      return Promise.all(
        attempts.map((attemptsSoFar) =>
          prisma.job.create({
            data: { organizationId, type, payload: {}, attempts: attemptsSoFar, runAfter: new Date(Date.now() - 1000) },
          })
        )
      )
    }

    it("reports retryable and exhausted failures", async () => {
      const organizationId = await organizationWithInvoices([])
      registerJobHandler("test.always_fails", async () => {
        throw new Error("provider down")
      })
      registerJobHandler("test.succeeds", async () => undefined)
      await queueJobs(organizationId, "test.always_fails", [0, 4])
      await queueJobs(organizationId, "test.succeeds", [0])
      const abandoned = await prisma.job.create({
        data: { organizationId, type: "test.succeeds", payload: {}, status: "running", attempts: 5 },
      })
      await prisma.$executeRaw`UPDATE "job" SET "updatedAt" = NOW() - INTERVAL '30 minutes' WHERE "id" = ${abandoned.id}`

      const result = await runDueJobs({ organizationIds: [organizationId] })

      expect(result).toEqual({ processed: 3, succeeded: 1, retrying: 1, failed: 2, deferred: 0, reclaimed: 1 })
      expect(
        await prisma.job.groupBy({ by: ["status"], where: { organizationId }, _count: true, orderBy: { status: "asc" } })
      ).toEqual([
        { status: "done", _count: 1 },
        { status: "failed", _count: 2 },
        { status: "pending", _count: 1 },
      ])
    })

    it("fails a job at once, without retrying, when its handler reports a terminal failure", async () => {
      const organizationId = await organizationWithInvoices([])
      let calls = 0
      registerJobHandler("test.terminal", async () => {
        calls += 1
        throw new TerminalJobError("recipient missing")
      })
      const [job] = await queueJobs(organizationId, "test.terminal", [0])

      const result = await runDueJobs({ organizationIds: [organizationId] })

      expect(result).toEqual({ processed: 1, succeeded: 0, retrying: 0, failed: 1, deferred: 0, reclaimed: 0 })
      expect(await prisma.job.findUniqueOrThrow({ where: { id: job!.id } })).toMatchObject({
        status: "failed",
        attempts: 1,
        lastError: "recipient missing",
      })

      // A later sweep does not pick it up again.
      const later = await runDueJobs({ organizationIds: [organizationId], now: new Date(Date.now() + DAY) })
      expect(later).toMatchObject({ processed: 0, failed: 0 })
      expect(calls).toBe(1)
    })

    it("claims no new job once the time budget is used", async () => {
      const organizationId = await organizationWithInvoices([])
      registerJobHandler("test.slow", async () => {
        await new Promise((resolve) => setTimeout(resolve, 30))
      })
      await queueJobs(organizationId, "test.slow", [0, 0, 0])

      const first = await runDueJobs({ organizationIds: [organizationId], timeBudgetMs: 10 })
      expect(first).toMatchObject({ processed: 1, succeeded: 1, deferred: 2 })
      expect(await prisma.job.count({ where: { organizationId, status: "pending" } })).toBe(2)

      const second = await runDueJobs({ organizationIds: [organizationId] })
      expect(second).toMatchObject({ processed: 2, succeeded: 2, deferred: 0 })
    })
  })
})
