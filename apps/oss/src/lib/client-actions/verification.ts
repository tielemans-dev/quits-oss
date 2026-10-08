import { randomInt } from "node:crypto"
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

export async function requestVerificationCode(
  link: ActiveClientActionLink,
  context: { sellerName: string | null; locale: string },
  now = new Date(),
  send: typeof sendClientActionCodeEmail = sendClientActionCodeEmail,
): Promise<CodeRequestOutcome> {
  if (link.verification !== "email_code" || !link.recipientEmail) return "unavailable"
  const recent = await prisma.clientActionVerification.count({
    where: { linkId: link.id, createdAt: { gte: new Date(now.getTime() - 3_600_000) } },
  })
  if (recent >= MAX_CODES_PER_HOUR) return "rate_limited"
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0")
  const record = await prisma.clientActionVerification.create({
    data: {
      linkId: link.id,
      codeHash: hashVerificationCode(link.id, code),
      expiresAt: new Date(now.getTime() + CLIENT_ACTION_CODE_MINUTES * 60_000),
    },
  })
  try {
    await send({
      to: link.recipientEmail,
      code,
      recipientName: link.recipientName,
      sellerName: context.sellerName,
      locale: context.locale,
    })
  } catch {
    // A code nobody received must not count against the hourly limit or stay valid.
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
  const latest = await prisma.clientActionVerification.findFirst({
    where: { linkId: link.id, consumedAt: null },
    orderBy: { createdAt: "desc" },
  })
  if (!latest || now >= latest.expiresAt) return "expired"
  if (latest.attempts >= MAX_CODE_ATTEMPTS) return "locked"
  // Count the attempt before comparing, so concurrent guesses cannot exceed the limit.
  const claimed = await prisma.clientActionVerification.updateMany({
    where: { id: latest.id, attempts: latest.attempts },
    data: { attempts: { increment: 1 } },
  })
  if (claimed.count !== 1) return "locked"
  if (!codesMatch(latest.codeHash, link.id, code)) return "wrong"
  const consumed = await prisma.clientActionVerification.updateMany({
    where: { id: latest.id, consumedAt: null },
    data: { consumedAt: now },
  })
  return consumed.count === 1 ? "verified" : "expired"
}
