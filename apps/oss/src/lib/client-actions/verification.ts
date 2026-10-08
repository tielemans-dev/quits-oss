import { randomInt } from "node:crypto"
import type { Prisma } from "../../../generated/prisma/client"
import { prisma } from "../db"
import { CLIENT_ACTION_CODE_MINUTES, sendClientActionCodeEmail } from "../emails/client-action-code-email"
import type { ActiveClientActionLink } from "./access"
import { codesMatch, hashVerificationCode } from "./tokens"

/**
 * Proving the recipient controls the email address a link was made for. An approver who has not
 * done so cannot decide anything, so a forwarded link opens the page but not the approvals.
 *
 * Codes are six digits, valid for ten minutes, tried at most five times, and at most five are sent
 * per link per hour. Only a digest of the code is stored.
 */
export const MAX_CODE_ATTEMPTS = 5
export const MAX_CODES_PER_HOUR = 5
/** How long a verified browser stays verified, within the life of the link. */
export const VERIFIED_SESSION_HOURS = 12

export type CodeRequestOutcome = "sent" | "rate_limited" | "unavailable"

/** Issuing and checking share a lock: a superseded challenge cannot win a concurrent check. */
async function lockChallenges(tx: Prisma.TransactionClient, linkId: string) {
  const key = `client-action-verification:${linkId}`
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`
}

export async function requestVerificationCode(
  link: ActiveClientActionLink,
  context: { sellerName: string | null; locale: string },
  now = new Date(),
  send: typeof sendClientActionCodeEmail = sendClientActionCodeEmail,
): Promise<CodeRequestOutcome> {
  if (link.verification !== "email_code" || !link.recipientEmail) return "unavailable"
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0")
  const record = await prisma.$transaction(async (tx) => {
    await lockChallenges(tx, link.id)
    const recent = await tx.clientActionVerification.count({
      where: { linkId: link.id, createdAt: { gte: new Date(now.getTime() - 3_600_000) } },
    })
    if (recent >= MAX_CODES_PER_HOUR) return null
    // Retire predecessors in the same transaction, including if the new delivery later fails.
    // Do not rely on timestamp ordering: two requests can have the same createdAt.
    await tx.clientActionVerification.updateMany({
      where: { linkId: link.id, consumedAt: null },
      data: { consumedAt: now },
    })
    return tx.clientActionVerification.create({
      data: {
        linkId: link.id,
        codeHash: hashVerificationCode(link.id, code),
        createdAt: now,
        expiresAt: new Date(now.getTime() + CLIENT_ACTION_CODE_MINUTES * 60_000),
      },
    })
  })
  if (!record) return "rate_limited"
  // Reserve before sending, but never hold a database transaction during network delivery.
  try {
    await send({
      to: link.recipientEmail,
      code,
      recipientName: link.recipientName,
      sellerName: context.sellerName,
      locale: context.locale,
    })
  } catch {
    // Refund only this failed send. Older challenges stay retired; a newer one stays current.
    await prisma.clientActionVerification.delete({ where: { id: record.id } }).catch(() => undefined)
    return "unavailable"
  }
  return "sent"
}

export type CodeCheckOutcome = "verified" | "wrong" | "expired" | "locked"

/** Checks against the newest code only: asking for a new code retires the older ones. */
export async function checkVerificationCode(
  link: ActiveClientActionLink,
  code: string,
  now = new Date(),
): Promise<CodeCheckOutcome> {
  return prisma.$transaction(async (tx) => {
    await lockChallenges(tx, link.id)
    const latest = await tx.clientActionVerification.findFirst({
      where: { linkId: link.id, consumedAt: null },
      orderBy: { createdAt: "desc" },
    })
    if (!latest || now >= latest.expiresAt) return "expired"
    if (latest.attempts >= MAX_CODE_ATTEMPTS) return "locked"
    const matches = codesMatch(latest.codeHash, link.id, code)
    // Consume and count under the same lock as replacement. At most one caller verifies.
    const claimed = await tx.clientActionVerification.updateMany({
      where: { id: latest.id, consumedAt: null, attempts: latest.attempts },
      data: { attempts: { increment: 1 }, ...(matches ? { consumedAt: now } : {}) },
    })
    if (claimed.count !== 1) return "expired"
    return matches ? "verified" : "wrong"
  })
}
