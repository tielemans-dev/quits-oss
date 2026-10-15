import { moneyMinor } from "@quits/shared/pricing"
import { Prisma } from "../../../generated/prisma/client"
import { dateRangeInTimeZone, formatIsoDate } from "./format"
import { nextVatReportingPeriod, VAT_PERIODS, type VatPeriod } from "../vat-deadline"
import { buildCsv, csvNumber } from "./csv"
import { minorToDecimal } from "../../components/kvit/amount-format"

const VatDecimal = Prisma.Decimal.clone({ precision: 40 })

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
  const [invoices, credits, entry] = await Promise.all([
    db.invoice.findMany({ where, select }), db.creditNote.findMany({ where, select }),
    db.vatPeriodEntry.findUnique({ where: { organizationId_from_to: { organizationId, from: period.from, to: period.to } } }),
  ])
  // Never add different currencies or invent a tax conversion from today's exchange rate.
  if ([...invoices, ...credits].some(row => row.currency !== "DKK")) return { available: false as const, reason: "currency" as const }
  const sum = (rows: typeof invoices) => rows.reduce((total, row) => total + BigInt(moneyMinor(row.totalTax.toString(), 2)), 0n)
  const outputVatMinor = (sum(invoices) - sum(credits)).toString()
  const inputVatMinor = entry?.inputVat == null ? null : entry.inputVat.mul(100).toFixed(0)
  return { available: true as const, period, outputVatMinor, inputVatMinor,
    payableVatMinor: vatPayableMinor(outputVatMinor, inputVatMinor),
    inputVatUpdatedAt: entry?.updatedAt.toISOString() ?? null, inputVatUpdatedBy: entry?.updatedBy ?? null }
}

export type VatOverview = Awaited<ReturnType<typeof vatOverview>>

export function vatPayableMinor(output: string, input: string | null) {
  return input === null ? null : new VatDecimal(output).minus(input).toFixed(0)
}

/** A worksheet for manual entry, with unknown fields left blank rather than reported as zero. */
export function tastSelvSummary(overview: Pick<Extract<VatOverview, { available: true }>, "period" | "outputVatMinor"> & { inputVatMinor?: string | null }) {
  const { period, outputVatMinor, inputVatMinor = null } = overview
  const payable = vatPayableMinor(outputVatMinor, inputVatMinor)
  return { filename: `moms-${period.from}_${period.to}.csv`, csv: buildCsv(["Felt", "DKK", "Bemærkning"], [
    ["Periode", null, `${period.from} - ${period.to}`],
    ["Frist", null, period.date],
    ["Salgsmoms (udgående moms)", csvNumber(minorToDecimal(BigInt(outputVatMinor), 2)), "Fakturaer minus kreditnotaer"],
    ["Købsmoms (indgående moms)", inputVatMinor === null ? null : csvNumber(minorToDecimal(BigInt(inputVatMinor), 2)), inputVatMinor === null ? "Ikke opgjort: udgifter er ikke registreret i quits" : "Manuelt angivet for perioden"],
    ["Moms i alt", payable === null ? null : csvNumber(minorToDecimal(BigInt(payable), 2)), payable === null ? "Kan ikke opgøres uden købsmoms" : "Salgsmoms minus købsmoms. Negativt beløb: til udbetaling"],
    [inputVatMinor === null ? "Delvis oversigt" : "Oversigt", null, inputVatMinor === null
      ? "Indtast selv i TastSelv. Intet er indberettet. Kontrollér øvrige felter og tilføj købsmoms fra dit regnskab."
      : "Indtast selv i TastSelv. Intet er indberettet. Kontrollér øvrige felter og købsmoms fra dit regnskab."],
  ]) }
}
