import { useMemo } from "react"

import { cn } from "../../lib/utils"
import { AMOUNT_UNAVAILABLE, formatAmountParts, type AmountPrecision, type AmountValue } from "./amount-format"

export type AmountSize = "sm" | "md" | "hero"
/** none: nothing yet (a draft). single: money asked for. double: money settled. */
export type AmountRule = "none" | "single" | "double"

/**
 * Per size: the type, how small the fraction is set, and where the two rules sit. Rules are drawn
 * on whole pixels so they stay crisp; `gap` is the air between the figure and the first rule.
 *
 * The hero fraction is 45% of the figure. At list size that would be 6px, so the list sets it at
 * 68% and the middle size at 58%: still raised, still reads as øre, but legible.
 */
const sizes: Record<
  AmountSize,
  { text: string; fraction: number; stroke: number; first: number; second: number; height: number; gap: number }
> = {
  sm: { text: "text-[14.5px] font-bold", fraction: 0.68, stroke: 1, first: 0.5, second: 3.5, height: 4, gap: 3 },
  md: { text: "text-[28px] font-extrabold tracking-[-0.025em]", fraction: 0.58, stroke: 2, first: 1, second: 5, height: 6, gap: 4 },
  hero: { text: "figure text-5xl sm:text-6xl", fraction: 0.45, stroke: 3, first: 1.5, second: 8.5, height: 10, gap: 8 },
}

function clamp01(value: number) {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0))
}

/**
 * Money in Schibsted Grotesk with the fraction raised and small (`48.250,⁰⁰ kr.`), optionally on
 * the Quits signature: a rule under the figure. One rule asks for the money, a second one says it
 * has arrived. The second rule draws left to right when `rule` goes from single to double, and
 * only as far as `paidFraction` for a part payment; with reduced motion it just appears.
 *
 * Screen readers get the amount as plain text, as the locale writes it, plus `statusLabel` when
 * the caller has a status that is not already said next to it. The rules and the raised styling
 * add nothing to what is read.
 *
 * The locale decides the separators and where the currency sits; pass the app's locale.
 */
export function Amount({
  value,
  currency,
  locale,
  size = "sm",
  rule = "none",
  paidFraction,
  statusLabel,
  ruleTone = "settled",
  precision,
  className,
}: {
  /** null (an amount that could not be written down, see `decimalFromNumber`) shows an em dash. */
  value: AmountValue | null
  currency: string
  locale?: string
  size?: AmountSize
  rule?: AmountRule
  /** 0 to 1: how much of the second rule is drawn, for a part payment. Ignored unless rule is double. */
  paidFraction?: number
  /** A translated status for screen readers ("Paid"), read after the amount. */
  statusLabel?: string
  /** settled draws the second rule in the success tone; current keeps it the text colour (on brand). */
  ruleTone?: "settled" | "current"
  /** The source's own precision (a three-decimal currency, an unknown one); see `AmountPrecision`. */
  precision?: AmountPrecision
  className?: string
}) {
  const spec = sizes[size]
  const parts = useMemo(
    () => (value === null ? null : formatAmountParts(value, currency, locale, precision)),
    [value, currency, locale, precision?.exponent, precision?.source]
  )

  const drawn = rule === "double" ? clamp01(paidFraction ?? 1) : 1
  const hidden = rule !== "double"

  return (
    <span
      data-slot="amount"
      data-rule={rule}
      className={cn("relative inline-block whitespace-nowrap align-baseline", spec.text, className)}
      style={{ paddingBottom: spec.height + spec.gap }}
    >
      {parts === null ? AMOUNT_UNAVAILABLE : parts.map((part, index) => {
        if (part.type === "fraction") {
          return (
            <span
              key={index}
              className="tabular-nums lining-nums relative"
              style={{
                fontSize: `${spec.fraction}em`,
                top: `${(-(1 - spec.fraction) * 0.72) / spec.fraction}em`,
                lineHeight: 1,
              }}
            >
              {part.value}
            </span>
          )
        }
        // Tabular digits only on digit runs: Schibsted's tnum would widen "." and "," to a digit.
        if (part.type === "integer") {
          return (
            <span key={index} className="tabular-nums lining-nums">
              {part.value}
            </span>
          )
        }
        return part.value
      })}
      {statusLabel ? <span className="sr-only">{`, ${statusLabel}`}</span> : null}
      {rule === "none" || parts === null ? null : (
        <svg
          aria-hidden="true"
          focusable="false"
          width="100%"
          height={spec.height}
          className="pointer-events-none absolute bottom-0 left-0 overflow-visible"
        >
          <line
            x1="0"
            x2="100%"
            y1={spec.first}
            y2={spec.first}
            stroke="currentColor"
            strokeWidth={spec.stroke}
            className={rule === "single" ? "opacity-50" : "opacity-90"}
          />
          <line
            x1="0"
            x2="100%"
            y1={spec.second}
            y2={spec.second}
            pathLength={1}
            stroke={ruleTone === "settled" ? "var(--tone-success)" : "currentColor"}
            strokeWidth={spec.stroke}
            strokeDasharray={`${drawn} 1`}
            strokeDashoffset={hidden ? drawn : 0}
            className="transition-[stroke-dashoffset,stroke-dasharray] duration-300 ease-[cubic-bezier(.2,.8,.2,1)] motion-reduce:transition-none"
          />
        </svg>
      )}
    </span>
  )
}
