import type { Prisma } from "../../../generated/prisma/client"
import { prisma } from "../../lib/db"
import { formatIsoDate } from "../../lib/exports/format"
import { addUtcDays, parseCalendarDate } from "../features/recurring-dates"
import { learnPaymentTerms, LEARN_WINDOW } from "./learned-defaults"

/** The only learned field today; the clear marker is keyed by it so others can follow. */
export const PAYMENT_TERMS_FIELD = "paymentTermsDays"

async function ownContact(organizationId: string, contactId: string, db: Prisma.TransactionClient = prisma) {
  return db.contact.findFirstOrThrow({ where: { id: contactId, organizationId }, select: { id: true } })
}

/** The terms this customer's own issued invoices agree on, for this organization only. */
export async function loadLearnedPaymentTerms(organizationId: string, contactId: string, db: Prisma.TransactionClient = prisma) {
  await ownContact(organizationId, contactId, db)
  const [recent, settings, cleared] = await Promise.all([
    db.invoice.findMany({
      // Drafts have no real issue date yet; recurring runs follow their schedule, not a correction.
      where: { organizationId, contactId, status: { not: "draft" }, recurringInvoiceId: null },
      orderBy: [{ issueDate: "desc" }, { createdAt: "desc" }],
      take: LEARN_WINDOW,
      select: { issueDate: true, dueDate: true, timezone: true },
    }),
    db.orgSettings.findUnique({ where: { organizationId }, select: { paymentTermsDays: true } }),
    db.learnedDefaultClear.findUnique({ where: { contactId_field: { contactId, field: PAYMENT_TERMS_FIELD } }, select: { clearedValue: true } }),
  ])
  return learnPaymentTerms(recent, settings?.paymentTermsDays, cleared?.clearedValue)
}

/**
 * The due date a new invoice for this customer gets today, as the invoice form sets it: the
 * customer's learned terms, else the organization's. Null when neither has terms.
 */
export async function paymentTermsDueDate(organizationId: string, contactId: string, timezone: string, now: Date, db: Prisma.TransactionClient = prisma) {
  const [learned, settings] = await Promise.all([
    loadLearnedPaymentTerms(organizationId, contactId, db),
    db.orgSettings.findUnique({ where: { organizationId }, select: { paymentTermsDays: true } }),
  ])
  const days = learned?.days ?? settings?.paymentTermsDays
  return days == null ? null : addUtcDays(parseCalendarDate(formatIsoDate(now, timezone)), days)
}

/** Clears what is learned right now, so it stays cleared until a different value is learned. */
export async function clearLearnedPaymentTerms(organizationId: string, contactId: string) {
  const learned = await loadLearnedPaymentTerms(organizationId, contactId)
  if (!learned) return { cleared: false as const }
  await prisma.learnedDefaultClear.upsert({
    where: { contactId_field: { contactId, field: PAYMENT_TERMS_FIELD } },
    create: { organizationId, contactId, field: PAYMENT_TERMS_FIELD, clearedValue: learned.days },
    update: { clearedValue: learned.days },
  })
  return { cleared: true as const }
}

/** Fortryd: the learned default comes back as it was. */
export async function restoreLearnedPaymentTerms(organizationId: string, contactId: string) {
  await ownContact(organizationId, contactId)
  await prisma.learnedDefaultClear.deleteMany({ where: { organizationId, contactId, field: PAYMENT_TERMS_FIELD } })
}
