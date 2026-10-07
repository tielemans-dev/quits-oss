import { randomUUID } from "node:crypto"
import { expect, it } from "vitest"
import { betterAuth } from "better-auth"
import { PrismaPg } from "@prisma/adapter-pg"
import { PrismaClient } from "../../../generated/prisma/client"
import { cleanupExpiredVerifications } from "../auth/verification-cleanup"
import { buildQuitsAuthOptions } from "../runtime/auth-config"

const databaseUrl = process.env.DATABASE_URL
const localDatabase = databaseUrl && ["localhost", "127.0.0.1"].includes(new URL(databaseUrl).hostname)

it.skipIf(!localDatabase).each(["UTC", "Europe/Copenhagen", "America/New_York"])("preserves fresh verifications and accepts the native reset GET with database timezone %s", async (timezone) => {
  // Apply to every pooled connection, including the root client's request-time cleanup.
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl, options: `-c timezone=${timezone}` }) })
  const origin = "http://localhost:3102"
  const secret = "verification-cleanup-test-secret-at-least-32-characters"
  const id = randomUUID()
  const email = `cleanup-${id}@example.com`
  const expiredId = randomUUID()
  const freshId = randomUUID()
  const background: Promise<void>[] = []
  let resetUrl = ""
  let token = ""
  const auth = betterAuth({
    ...buildQuitsAuthOptions({
      prisma,
      env: { getEnv: (name) => ({ BETTER_AUTH_URL: origin, BETTER_AUTH_SECRET: secret })[name] },
      hooks: {
        getRecoveryClientKey: () => id,
        runInBackground: (task) => { background.push(task) },
        sendResetPassword: async (data) => { resetUrl = data.url; token = data.token },
      },
    }),
    secret,
    logger: { disabled: true },
  })
  try {
    expect(await prisma.$queryRaw`SELECT current_setting('TimeZone') AS timezone`).toEqual([{ timezone }])
    await prisma.user.create({ data: { id, email, name: "Cleanup Timezone", emailVerified: false, createdAt: new Date(), updatedAt: new Date() } })
    const requested = await auth.handler(new Request(`${origin}/api/auth/request-password-reset`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ email, redirectTo: `${origin}/reset-password` }),
    }))
    expect(requested.status).toBe(200)
    await Promise.all(background)
    const verification = await prisma.verification.findFirstOrThrow({ where: { value: id } })
    expect(verification.expiresAt.getTime() - Date.now()).toBeGreaterThan(1_700_000)
    await prisma.verification.createMany({ data: [
      { id: expiredId, identifier: randomUUID(), value: id, expiresAt: new Date(Date.now() - 60_000) },
      { id: freshId, identifier: randomUUID(), value: id, expiresAt: new Date(Date.now() + 1_800_000) },
    ] })
    const callback = await auth.handler(new Request(resetUrl))
    expect(callback.status).toBe(302)
    const location = new URL(callback.headers.get("location")!)
    expect(location.pathname).toBe("/reset-password")
    expect(location.searchParams.get("error")).toBeNull()
    expect(location.searchParams.get("token")).toBe(token)
    expect((await prisma.verification.findMany({ where: { value: id }, select: { id: true } })).map(({ id }) => id).sort()).toEqual([verification.id, freshId].sort())
    expect(await prisma.verification.findUnique({ where: { id: expiredId } })).toBeNull()
  } finally {
    await Promise.all(background)
    await prisma.verification.deleteMany({ where: { value: id } })
    await prisma.user.deleteMany({ where: { id } })
    const key = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${secret}\0/request-password-reset\0${id}`))
    await prisma.authRecoveryRateLimit.deleteMany({ where: { key: Buffer.from(key).toString("hex") } })
    await prisma.$disconnect()
  }
})

// Cleanup is database-wide. Run alone so other auth requests cannot drain this fixture's rows.
it.skipIf(!localDatabase)("bounds expired verification cleanup, skips held rows and drains them after release", async () => {
  const clients = Array.from({ length: 2 }, () => new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) }))
  const prisma = clients[0]!
  const value = randomUUID()
  const expired = new Date(Date.now() - 60_000)
  const liveId = randomUUID()
  const heldId = randomUUID()
  let release!: () => void
  let entered!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  const locked = new Promise<void>((resolve) => { entered = resolve })
  let locking: Promise<void> | undefined
  try {
    await prisma.verification.createMany({ data: [
      ...Array.from({ length: 205 }, () => ({ id: randomUUID(), identifier: randomUUID(), value, expiresAt: expired })),
      { id: heldId, identifier: randomUUID(), value, expiresAt: expired },
      { id: liveId, identifier: randomUUID(), value, expiresAt: new Date(Date.now() + 60_000) },
    ] })
    locking = clients[1]!.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM verification WHERE id = ${heldId} FOR UPDATE`
      entered()
      await held
    })
    await locked
    expect(await cleanupExpiredVerifications(prisma)).toBeLessThanOrEqual(100)
    expect(await prisma.verification.count({ where: { value } })).toBeGreaterThanOrEqual(107)
    // Repeated bounded passes make progress without waiting for the held expired record.
    for (let pass = 0; pass < 10; pass++) {
      const deleted = await cleanupExpiredVerifications(prisma)
      expect(deleted).toBeLessThanOrEqual(100)
      if (deleted === 0) break
    }
    expect((await prisma.verification.findMany({ where: { value }, select: { id: true } })).map(({ id }) => id).sort()).toEqual([heldId, liveId].sort())
    release()
    await locking
    expect(await cleanupExpiredVerifications(prisma)).toBe(1)
    expect((await prisma.verification.findMany({ where: { value }, select: { id: true } })).map(({ id }) => id)).toEqual([liveId])
  } finally {
    release()
    await locking
    await prisma.verification.deleteMany({ where: { value } })
    await Promise.all(clients.map((client) => client.$disconnect()))
  }
})
