import { moneyMinor } from "@quits/shared/pricing"

/** JSON numbers are a boundary conversion only; money checks use shared Decimal helpers. */
export function apiAmount(amount: string, credit = false): number {
  const minor = BigInt(moneyMinor(amount, 2))
  if (minor < 0n || minor > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Unsafe money amount")
  const value = Number(credit && minor !== 0n ? `-${amount}` : amount)
  if (moneyMinor(String(value), 2) !== (credit ? -minor : minor).toString()) throw new Error("Lossy JSON number")
  return value
}
