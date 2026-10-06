import { Prisma } from "../../../generated/prisma/client"

/**
 * Converts tool output to plain JSON: money (Prisma Decimal) becomes a number, dates become ISO
 * strings, and `undefined` fields are dropped. Agents never see library-specific types.
 */
export function toJsonValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return null
  }
  if (value instanceof Date) {
    return value.toISOString()
  }
  if (Prisma.Decimal.isDecimal(value)) {
    return (value as Prisma.Decimal).toNumber()
  }
  if (Array.isArray(value)) {
    return value.map(toJsonValue)
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, toJsonValue(entry)])
    return Object.fromEntries(entries)
  }
  if (typeof value === "bigint") {
    return value.toString()
  }
  return value
}
