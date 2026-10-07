import { randomUUID } from "node:crypto"
import { expect, it } from "vitest"
import { PrismaPg } from "@prisma/adapter-pg"
import { PrismaClient } from "../../../generated/prisma/client"
import { cleanupExpiredVerifications } from "../auth/verification-cleanup"

const databaseUrl = process.env.DATABASE_URL
const localDatabase = databaseUrl && ["localhost", "127.0.0.1"].includes(new URL(databaseUrl).hostname)

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
