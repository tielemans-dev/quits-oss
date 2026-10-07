/** The first instant after validUntil in the agreement's frozen time zone, including DST gaps. */
export function agreementExpiresAt(validUntil: Date, timezone: string): Date {
  const lastDay = validUntil.toISOString().slice(0, 10)
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
  function dayAt(ms: number) {
    const parts = formatter.formatToParts(new Date(ms))
    const part = (type: string) => parts.find((p) => p.type === type)!.value
    return `${part("year")}-${part("month")}-${part("day")}`
  }
  let lo = validUntil.getTime() - 48 * 3600_000
  let hi = validUntil.getTime() + 72 * 3600_000
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2)
    if (dayAt(mid) <= lastDay) lo = mid
    else hi = mid
  }
  return new Date(hi)
}
