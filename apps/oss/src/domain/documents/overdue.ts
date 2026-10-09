import { Prisma } from "../../../generated/prisma/client"

/** Current scheduler policy: strictly past the stored due timestamp, even on the due day.
 * Keep SQL selection and dashboard classification together here. A future calendar-day policy
 * must change both branches together and account for the organization's timezone.
 */
export function isInvoicePastDue(dueDate: Date, now: Date): boolean
export function isInvoicePastDue(dueDate: Prisma.Sql, now: Date): Prisma.Sql
export function isInvoicePastDue(dueDate: Date | Prisma.Sql, now: Date): boolean | Prisma.Sql {
  return dueDate instanceof Date ? dueDate < now : Prisma.sql`${dueDate} < (${now.toISOString()}::timestamptz AT TIME ZONE 'UTC')`
}
