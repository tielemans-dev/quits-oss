import { createHash, randomUUID } from "node:crypto"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { betterAuth } from "better-auth"
import { PrismaPg } from "@prisma/adapter-pg"
import { Prisma, PrismaClient } from "../../../generated/prisma/client"
import { admitRecoveryRequest } from "../auth/password-recovery"
import { buildQuitsAuthOptions } from "../runtime/auth-config"

const databaseUrl = process.env.DATABASE_URL
const localDatabase = databaseUrl && ["localhost", "127.0.0.1"].includes(new URL(databaseUrl).hostname)
const zones = ["UTC", "Europe/Copenhagen"]
const clients: PrismaClient[] = []
const keys: string[] = []
const secret = "recovery-timezone-test-secret-at-least-32-characters"
const origin = "http://localhost:3102"

beforeAll(async () => {
  if (!localDatabase) return
  for (const zone of zones) {
    const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl, options: `-c timezone=${zone}` }) })
    await client.$connect()
    clients.push(client)
  }
})
afterEach(async () => {
  if (clients.length) await clients[0]!.authRecoveryRateLimit.deleteMany({ where: { key: { in: keys } } })
  keys.length = 0
})
afterAll(async () => { await Promise.all(clients.map((client) => client.$disconnect())) })

function bucket(path: string) {
  const peer = randomUUID()
  const key = createHash("sha256").update(`${secret}\0${path}\0${peer}`).digest("hex")
  keys.push(key)
  return { peer, key }
}

// Execute the production statements on PostgreSQL with a pinned NOW(), without changing
// the server clock. Preserve every parameter and cast so DST tests cover the storage boundary.
function atInstant(client: PrismaClient, instant: string): PrismaClient {
  const sql = (strings: TemplateStringsArray, values: unknown[]) => {
    const parts = strings.map((part) => part.replaceAll("NOW()", "TIMESTAMPTZ '" + instant + "'"))
    return Prisma.sql(Object.assign(parts, { raw: parts }), ...values)
  }
  return {
    $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => client.$executeRaw(sql(strings, values)),
    $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => client.$queryRaw(sql(strings, values)),
  } as PrismaClient
}

async function isolatedBuckets(client: PrismaClient, work: (db: PrismaClient) => Promise<void>) {
  await client.$transaction(async (tx) => {
    // Shadow only the admission table on this connection. Pinned clocks and request-time
    // cleanup from other suites cannot delete each other's buckets.
    await tx.$executeRaw`CREATE TEMP TABLE auth_recovery_rate_limit (LIKE public.auth_recovery_rate_limit INCLUDING ALL) ON COMMIT DROP`
    await work(tx as PrismaClient)
  })
}

async function readBucket(db: PrismaClient, key: string) {
  const [row] = await db.$queryRaw<{ count: number; resetAt: Date }[]>`
    SELECT count, "resetAt" FROM auth_recovery_rate_limit WHERE key = ${key}
  `
  return row!
}

describe.skipIf(!localDatabase)("UTC recovery admission on PostgreSQL", () => {
  it.each([
    { path: "/request-password-reset", max: 3, first: 0, status: 200 },
    { path: "/request-password-reset", max: 3, first: 1, status: 200 },
    { path: "/reset-password", max: 5, first: 0, status: 400 },
    { path: "/reset-password", max: 5, first: 1, status: 400 },
  ])("shares the $max request limit for $path starting in timezone $first", async ({ path, max, first, status }) => {
    const { peer, key } = bucket(path)
    const auths = clients.map((prisma) => betterAuth({
      ...buildQuitsAuthOptions({
        prisma,
        env: { getEnv: (name) => ({ BETTER_AUTH_URL: origin, BETTER_AUTH_SECRET: secret })[name] },
        hooks: { getRecoveryClientKey: () => peer, sendResetPassword: async () => { throw new Error("Unexpected known fixture") } },
      }),
      secret, logger: { disabled: true },
    }))
    const body = path === "/request-password-reset"
      ? { email: `${peer}@example.com`, redirectTo: `${origin}/reset-password` }
      : { token: peer, newPassword: "unused-fixture-password123" }
    const post = (index: number) => auths[index]!.handler(new Request(`${origin}/api/auth${path}`, {
      method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify(body),
    }))
    for (let index = 0; index < max; index++) expect((await post(first)).status).toBe(status)
    const blocked = await Promise.all(Array.from({ length: max + 1 }, (_, index) => post(index % 2)))
    expect(blocked.map((response) => response.status)).toEqual(Array(max + 1).fill(429))
    expect(blocked.every((response) => response.headers.get("retry-after") === "60")).toBe(true)
    for (const client of clients) {
      const [row] = await client.$queryRaw<{ count: number; seconds: number }[]>`
        SELECT count, EXTRACT(EPOCH FROM ("resetAt" - (NOW() AT TIME ZONE 'UTC')))::float AS seconds
        FROM auth_recovery_rate_limit WHERE key = ${key}
      `
      expect(row!.count).toBe(max)
      expect(row!.seconds).toBeGreaterThan(50)
      expect(row!.seconds).toBeLessThanOrEqual(60)
    }
    // A UTC-stored expired bucket must renew correctly on either timezone connection.
    await clients[0]!.authRecoveryRateLimit.update({ where: { key }, data: { resetAt: new Date(Date.now() - 1000) } })
    expect((await post(1 - first)).status).toBe(status)
    expect((await clients[0]!.authRecoveryRateLimit.findUniqueOrThrow({ where: { key } })).count).toBe(1)
  })

  it.each([0, 1])("cleans only buckets expired for more than an hour in timezone %s", async (index) => {
    const expired = bucket("/request-password-reset")
    const recent = bucket("/request-password-reset")
    const start = "2026-10-25 00:30:00+00"
    await isolatedBuckets(clients[index]!, async (db) => {
      await db.$executeRaw`
        INSERT INTO auth_recovery_rate_limit (key, count, "resetAt") VALUES
          (${expired.key}, 3, TIMESTAMP '2026-10-24 22:30:00'),
          (${recent.key}, 3, TIMESTAMP '2026-10-24 23:31:00')
      `
      const active = bucket("/request-password-reset")
      await admitRecoveryRequest(atInstant(db, start), "/request-password-reset", active.peer, secret)
      expect(await readBucket(db, expired.key)).toBeUndefined()
      expect(await readBucket(db, recent.key)).toBeDefined()
    })
  })

  it.each([
    "2026-10-25T00:30:00Z", "2026-10-25T00:59:30Z", "2026-10-25T01:30:00Z",
    "2026-03-29T00:59:30Z",
  ])("keeps a 60 second UTC window across the Copenhagen DST boundary at %s", async (start) => {
    for (const path of ["/request-password-reset", "/reset-password"]) {
      await isolatedBuckets(clients[0]!, async (db) => {
        const { peer, key } = bucket(path)
        const max = path === "/request-password-reset" ? 3 : 5
        const at = (seconds: number) => new Date(Date.parse(start) + seconds * 1000).toISOString()
        for (let attempt = 0; attempt < max; attempt++) {
          await db.$executeRawUnsafe(`SET LOCAL timezone = '${zones[attempt % 2]}'`)
          await admitRecoveryRequest(atInstant(db, at(0)), path, peer, secret)
        }
        const row = await readBucket(db, key)
        expect(row.resetAt.toISOString()).toBe(at(60))
        for (const zone of zones) {
          await db.$executeRawUnsafe(`SET LOCAL timezone = '${zone}'`)
          await expect(admitRecoveryRequest(atInstant(db, at(59)), path, peer, secret)).rejects.toMatchObject({ status: "TOO_MANY_REQUESTS" })
        }
        await admitRecoveryRequest(atInstant(db, at(60)), path, peer, secret)
        expect((await readBucket(db, key)).count).toBe(1)
        await db.$executeRaw`SET LOCAL timezone = 'UTC'`
        await admitRecoveryRequest(atInstant(db, at(61)), path, peer, secret)
        const renewed = await readBucket(db, key)
        expect(renewed.count).toBe(2)
        expect(renewed.resetAt.toISOString()).toBe(at(120))
      })
    }
  })
})
