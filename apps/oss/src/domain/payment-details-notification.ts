import { z } from "zod"
import { PAYMENT_DETAILS_FIELDS } from "@quits/contracts/payment-details"
import { prisma } from "../lib/db"
import { fromAddress } from "../lib/email"
import { getEmailDeliveryRuntimeStatus } from "../lib/email-delivery"
import { sendPaymentDetailsChangedEmail } from "../lib/emails/payment-details-changed-email"
import { appLogger } from "../lib/observability"
import { getRuntimeCapabilities } from "../lib/runtime/extensions"
import { getRuntimeEnv, getRuntimePlatform } from "../lib/runtime/platform"
import { registerJobHandler } from "./jobs"

export const PAYMENT_DETAILS_CHANGED_JOB = "payment_details.notify_changed"

/**
 * How long the notification waits before it may run. The command that records the change runs
 * its jobs right after it commits, while the person who saved is waiting for the answer; a
 * mail provider that is slow must not make saving slow. The scheduler tick sends it instead.
 */
export const PAYMENT_DETAILS_NOTIFICATION_DELAY_MS = 30_000

const logger = appLogger.child("payment-details")

export const paymentDetailsChangedJobSchema = z.object({
  changedBy: z.string(),
  changedAt: z.iso.datetime(),
  changes: z
    .array(
      z.object({
        field: z.enum(PAYMENT_DETAILS_FIELDS),
        before: z.string().nullable(),
        after: z.string().nullable(),
      })
    )
    .min(1),
})
export type PaymentDetailsChangedJob = z.infer<typeof paymentDetailsChangedJobSchema>

/** Whether the roles stored for a member (a comma-separated list) include one that may be warned. */
function isOwnerOrAdmin(roles: string) {
  return roles.split(",").some((role) => ["owner", "admin"].includes(role.trim()))
}

export type PaymentDetailsNotificationResult =
  | { status: "skipped"; reason: "email_delivery_not_configured" | "no_recipients" }
  | { status: "sent"; sent: number; failed: number }

/**
 * Tells the organization's owners and admins that its bank details changed. Best effort: with no
 * email provider configured (a self-hosted install without one) it quietly does nothing, and a
 * delivery that fails is logged and does not stop the others. Only the masked values leave the
 * audit log; the full numbers are never in the job.
 */
export async function notifyPaymentDetailsChanged(
  organizationId: string,
  change: PaymentDetailsChangedJob,
  deliveryKey: string
): Promise<PaymentDetailsNotificationResult> {
  const environment = getRuntimeEnv()
  const delivery = getEmailDeliveryRuntimeStatus({
    managed: getRuntimeCapabilities().emailDelivery.managed,
    resendApiKey: environment.RESEND_API_KEY,
    fromEmail: environment.FROM_EMAIL,
    emailProvider: environment.EMAIL_PROVIDER,
    smtp: environment,
    runtimeKind: getRuntimePlatform().getRuntimeKind(),
  })
  if (!delivery.available) {
    logger.info("payment_details.notification_skipped", {
      organizationId,
      reason: "email_delivery_not_configured",
      missing: delivery.missing,
    })
    return { status: "skipped", reason: "email_delivery_not_configured" }
  }

  const [members, organization, settings] = await Promise.all([
    prisma.member.findMany({
      where: { organizationId },
      select: { role: true, user: { select: { email: true } } },
    }),
    prisma.organization.findUnique({ where: { id: organizationId }, select: { name: true } }),
    prisma.orgSettings.findUnique({
      where: { organizationId },
      select: { locale: true, timezone: true, companyName: true },
    }),
  ])
  const recipients = [
    ...new Set(
      members
        .filter((member) => isOwnerOrAdmin(member.role))
        .map((member) => member.user.email.trim())
        .filter(Boolean)
    ),
  ]
  if (recipients.length === 0) {
    logger.info("payment_details.notification_skipped", { organizationId, reason: "no_recipients" })
    return { status: "skipped", reason: "no_recipients" }
  }

  const organizationName = settings?.companyName?.trim() || organization?.name || "Quits"
  let sent = 0
  let failed = 0
  for (const to of recipients) {
    try {
      await sendPaymentDetailsChangedEmail(
        {
          to,
          changedBy: change.changedBy,
          changedAt: change.changedAt,
          changes: change.changes,
          organizationName,
          locale: settings?.locale,
          timezone: settings?.timezone,
          fromEmail: fromAddress(environment),
        },
        { environment, idempotencyKey: `payment-details-changed:${deliveryKey}:${to.toLowerCase()}` }
      )
      sent += 1
    } catch (error) {
      failed += 1
      logger.warn("payment_details.notification_failed", { organizationId, error })
    }
  }
  return { status: "sent", sent, failed }
}

registerJobHandler(PAYMENT_DETAILS_CHANGED_JOB, async (job) => {
  await notifyPaymentDetailsChanged(job.organizationId, paymentDetailsChangedJobSchema.parse(job.payload), job.id)
})
