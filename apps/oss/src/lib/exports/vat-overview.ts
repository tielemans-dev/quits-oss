import { moneyMinor } from "@quits/shared/pricing"
import type { Prisma } from "../../../generated/prisma/client"
import { dateRangeInTimeZone, formatIsoDate } from "./format"
import { nextVatReportingPeriod, VAT_PERIODS, type VatPeriod } from "../vat-deadline"
import { buildCsv, csvNumber } from "./csv"
import { minorToDecimal } from "../../components/kvit/amount-format"

/** Uses the same issued-document tax and issue-date selection as the accounting export. */
export async function vatOverview(db: Prisma.TransactionClient, organizationId: string, now = new Date()) {
  const settings = await db.orgSettings.findUnique({ where: { organizationId },
    select: { momsRegistered: true, countryCode: true, taxRegime: true, vatPeriod: true, timezone: true } })
  if (settings?.momsRegistered !== true || settings.countryCode !== "DK" || settings.taxRegime !== "eu_vat") {
    return { available: false as const, reason: "registration" as const }
  }
  if (!VAT_PERIODS.includes(settings.vatPeriod as VatPeriod)) return { available: false as const, reason: "period" as const }
  const period = nextVatReportingPeriod(settings.vatPeriod as VatPeriod, formatIsoDate(now, settings.timezone))
  const { start, end } = dateRangeInTimeZone(period.from, period.to, settings.timezone)
  const where = { organizationId, status: { not: "draft" }, issueDate: { gte: start, lt: end } }
  const select = { totalTax: true, currency: true }
  const [invoices, credits] = await Promise.all([
    db.invoice.findMany({ where, select }), db.creditNote.findMany({ where, select }),
  ])
  // Never add different currencies or invent a tax conversion from today's exchange rate.
  if ([...invoices, ...credits].some(row => row.currency !== "DKK")) return { available: false as const, reason: "currency" as const }
  const sum = (rows: typeof invoices) => rows.reduce((total, row) => total + BigInt(moneyMinor(row.totalTax.toString(), 2)), 0n)
  return { available: true as const, period, outputVatMinor: (sum(invoices) - sum(credits)).toString() }
}

export type VatOverview = Awaited<ReturnType<typeof vatOverview>>

/** A worksheet for manual entry, with unknown fields left blank rather than reported as zero. */
export function tastSelvSummary(overview: Extract<VatOverview, { available: true }>) {
  const { period, outputVatMinor } = overview
  return { filename: `moms-${period.from}_${period.to}.csv`, csv: buildCsv(["Felt", "DKK", "Bemærkning"], [
    ["Periode", null, `${period.from} - ${period.to}`],
    ["Frist", null, period.date],
    ["Salgsmoms (udgående moms)", csvNumber(minorToDecimal(BigInt(outputVatMinor), 2)), "Fakturaer minus kreditnotaer"],
    ["Købsmoms (indgående moms)", null, "Ikke opgjort: udgifter er ikke registreret i quits"],
    ["Moms i alt", null, "Kan ikke opgøres uden købsmoms"],
    ["Delvis oversigt", null, "Indtast selv i TastSelv. Intet er indberettet. Kontrollér øvrige felter og tilføj købsmoms fra dit regnskab."],
  ]) }
}
