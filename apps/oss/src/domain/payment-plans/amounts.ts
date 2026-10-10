import type { VatGroup } from "@quits/contracts/vat"
import { requireCurrencyExponent } from "@quits/shared/currency"
import { creditComponents, moneyMinor } from "@quits/shared/pricing"

/** Plans hold integer minor units; arithmetic is exact bigint, never floating point. */
export const sumMinor = (values: Array<string | bigint>) => values.reduce<bigint>((total, value) => total + BigInt(value), 0n)

/** `1250000` DKK is `"12500.00"`. */
export function formatMinor(minor: string | bigint, currency: string) {
  const exponent = requireCurrencyExponent(currency)
  const value = BigInt(minor), sign = value < 0n ? "-" : "", digits = (value < 0n ? -value : value).toString().padStart(exponent + 1, "0")
  return exponent === 0 ? `${sign}${digits}` : `${sign}${digits.slice(0, -exponent)}.${digits.slice(-exponent)}`
}

/** A decimal amount at the currency's precision; sub-minor input is refused, never rounded. */
export const minorFromAmount = (amount: string, currency: string) => moneyMinor(amount, requireCurrencyExponent(currency))

/** Half-up for nonnegative operands: round(numerator / denominator). */
const roundHalfUp = (numerator: bigint, denominator: bigint) => (2n * numerator + denominator) / (2n * denominator)

/**
 * Ratio shares in basis points, resolved by cumulative half-up rounding: each share is the
 * difference of two rounded cumulative entitlements, so shares sum exactly to the total and the
 * last absorbs the residual. 100.00 in three equal thirds is 33.33, 33.33, 33.34.
 */
export function resolveRatioShares(totalMinor: bigint, basisPoints: number[]) {
  if (totalMinor < 0n) throw new RangeError("Total must not be negative")
  if (basisPoints.reduce((total, value) => total + value, 0) !== 10_000) throw new RangeError("Ratios must total 10000 basis points")
  let cumulative = 0n, previous = 0n
  return basisPoints.map((points) => {
    cumulative += BigInt(points)
    const entitled = roundHalfUp(totalMinor * cumulative, 10_000n)
    const share = entitled - previous
    previous = entitled
    return share
  })
}

export type ShareComponents = {
  grossMinor: bigint
  netMinor: bigint
  taxMinor: bigint
  payableRoundingMinor: bigint
  groups: Array<{ key: string; grossMinor: bigint; netMinor: bigint; taxMinor: bigint; payableRoundingMinor: bigint }>
}

/**
 * VAT composition of consecutive shares of one obligation. Each share is spread over the frozen
 * groups by their remaining gross (largest remainder, group order breaks ties), then each group's
 * tax and payable rounding follow the cumulative entitlement rule credit notes already use
 * (`creditComponents`). The shares together reproduce every frozen group component exactly.
 */
export function shareComponents(groups: VatGroup[], shares: bigint[], currency: string): ShareComponents[] {
  const exponent = requireCurrencyExponent(currency)
  const groupGross = groups.map((group) => BigInt(moneyMinor(group.gross, exponent)))
  const total = sumMinor(groupGross)
  if (sumMinor(shares) !== total) throw new RangeError("Shares must total the obligation's frozen gross")
  const before = groupGross.map(() => 0n)
  return shares.map((share) => {
    const remaining = groupGross.map((gross, index) => gross - before[index]!)
    const remainingTotal = sumMinor(remaining)
    const floors = remaining.map((value) => (remainingTotal === 0n ? 0n : (share * value) / remainingTotal))
    const ranked = remaining
      .map((value, index) => ({ index, remainder: remainingTotal === 0n ? 0n : (share * value) % remainingTotal }))
      .sort((a, b) => (a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1))
    const missing = Number(share - sumMinor(floors))
    for (let rank = 0; rank < missing; rank += 1) floors[ranked[rank]!.index]! += 1n
    const parts = groups.flatMap((group, index) => {
      const gross = floors[index]!
      if (gross === 0n) return []
      const part = creditComponents({ group, cumulativeBefore: formatMinor(before[index]!, currency), creditedGross: formatMinor(gross, currency) })
      before[index] = before[index]! + gross
      const minor = (amount: string) => BigInt(moneyMinor(amount, exponent))
      return [{ key: group.key, grossMinor: gross, netMinor: minor(part.net), taxMinor: minor(part.tax), payableRoundingMinor: minor(part.payableRounding) }]
    })
    return {
      grossMinor: share,
      netMinor: sumMinor(parts.map((part) => part.netMinor)),
      taxMinor: sumMinor(parts.map((part) => part.taxMinor)),
      payableRoundingMinor: sumMinor(parts.map((part) => part.payableRoundingMinor)),
      groups: parts,
    }
  })
}
