/**
 * Danish moms filing deadlines. Both periods are due on the 1st of the third month after the
 * period ends, so Q3 (to 30 Sep) is due 1 Dec. The table is the authority; nothing is computed from
 * the invoices. A deadline on a weekend moves to the next Monday. Public holidays are not modelled.
 */
export const VAT_PERIODS = ["quarterly", "half_yearly"] as const
export type VatPeriod = (typeof VAT_PERIODS)[number]

/** `due` is a month (1-12) and day; `yearOffset` is 1 when the deadline falls in the year after the period. */
const DEADLINES: Record<VatPeriod, Array<{ label: string; due: [month: number, day: number]; yearOffset: 0 | 1 }>> = {
  quarterly: [
    { label: "Q1", due: [6, 1], yearOffset: 0 },
    { label: "Q2", due: [9, 1], yearOffset: 0 },
    { label: "Q3", due: [12, 1], yearOffset: 0 },
    { label: "Q4", due: [3, 1], yearOffset: 1 },
  ],
  half_yearly: [
    { label: "H1", due: [9, 1], yearOffset: 0 },
    { label: "H2", due: [3, 1], yearOffset: 1 },
  ],
}

export type VatDeadline = {
  /** Q1-Q4 or H1-H2: the period the deadline reports. */
  label: string
  /** YYYY-MM-DD. */
  date: string
  daysLeft: number
}

function dueDate(year: number, [month, day]: [number, number]): string {
  const date = new Date(Date.UTC(year, month - 1, day))
  const weekday = date.getUTCDay()
  if (weekday === 6) date.setUTCDate(date.getUTCDate() + 2)
  if (weekday === 0) date.setUTCDate(date.getUTCDate() + 1)
  return date.toISOString().slice(0, 10)
}

/** The first deadline that has not passed on `today` (YYYY-MM-DD, the organization's date). Today still counts. */
export function nextVatDeadline(period: VatPeriod, today: string): VatDeadline {
  const year = Number(today.slice(0, 4))
  // The deadline for last year's last period can still be ahead in the new year.
  for (const reportYear of [year - 1, year]) {
    for (const entry of DEADLINES[period]) {
      const date = dueDate(reportYear + entry.yearOffset, entry.due)
      if (date >= today) {
        return { label: entry.label, date, daysLeft: Math.round((Date.parse(date) - Date.parse(today)) / 86_400_000) }
      }
    }
  }
  throw new Error("unreachable: the next year's deadlines always lie ahead")
}
