import { prisma } from "../db"
import { boundLockTransaction } from "../transaction-timeouts"
import { InvalidState } from "../../domain/errors"
import { canonicalizeOffer } from "../../domain/agreements/snapshot"

export type PublicLinkIdentity = {
  documentKind: "agreement" | "quote"
  documentId: string
  scope: string
  keyVersion: number
  targetId: string | null
  revision: number
}
/** Separate transaction: even a refused decision counts. Serialize each verified identity bucket. */
export async function recordPublicLinkAttempt(identity: PublicLinkIdentity, now = new Date()) {
  const count = await prisma.$transaction(async (tx) => {
    await boundLockTransaction(tx)
    const key = canonicalizeOffer(identity)
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`
    await tx.publicLinkAttempt.create({ data: { ...identity, createdAt: now } })
    return tx.publicLinkAttempt.count({
      where: { ...identity, createdAt: { gte: new Date(now.getTime() - 3600_000), lte: now } },
    })
  })
  if (count > 10)
    throw new InvalidState({
      code: "retry_later",
      message: "Too many submissions. Please try again later.",
    })
}
