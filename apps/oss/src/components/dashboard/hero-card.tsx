import { useMemo } from "react"

import { useI18n } from "../../lib/i18n/react"
import { cn } from "../../lib/utils"
import { Amount } from "../kvit/amount"
import { formatAmountText, minorToDecimal } from "../kvit/amount-format"
import { Panel } from "../kvit/panel"
import { tCount } from "./i18n"
import { precisionOf, toMinor, type HeroModel } from "./summary-model"

/**
 * The bar's three colours, also its legend's dots: received is green because it is money in,
 * what is still on its way neutral, and overdue amber. They are graphics; the figures beside them
 * are text in ink.
 */
const TONES = { paid: "bg-settled", pending: "bg-(--neutral-22)", overdue: "bg-tone-warning" }

/**
 * Udestående: how much money is on its way to me. One figure, on a single rule while money is
 * asked for and on both once nothing is owed (the signature); one sentence of what it means; then
 * how this month splits, each amount said once, and any other currency on a line of its own. The
 * attention list above says what is late and by how long.
 */
export function HeroCard({
  hero,
  kvit,
  monthName,
  className,
}: {
  hero: HeroModel
  /** Nothing is owed and money has moved: the second rule is drawn. */
  kvit: boolean
  monthName: string
  className?: string
}) {
  const { t, locale } = useI18n()
  const { precision } = hero
  const exponent = precision.exponent
  const owedMinor = hero.outstanding ? toMinor(hero.outstanding) : 0n
  const text = (amount: string) => formatAmountText(amount, hero.currency, locale, precision)

  const split = useMemo(() => {
    if (!hero.segments) return null
    const { paid, pending, overdue } = hero.segments
    const paidText = hero.paid ? text(hero.paid.amount) : text(minorToDecimal(0n, exponent))
    const overdueText = hero.overdue ? text(hero.overdue.bucket.amount) : text(minorToDecimal(0n, exponent))
    const pendingMinor = owedMinor - (hero.overdue ? toMinor(hero.overdue.bucket) : 0n)
    const pendingText = text(minorToDecimal(pendingMinor > 0n ? pendingMinor : 0n, exponent))
    return {
      parts: [
        { key: "paid", share: paid, label: t("dashboard.hero.legendPaid", { month: monthName }), amount: paidText, className: TONES.paid },
        { key: "pending", share: pending, label: t("dashboard.hero.legendPending"), amount: pendingText, className: TONES.pending },
        { key: "overdue", share: overdue, label: t("dashboard.hero.legendOverdue"), amount: overdueText, className: TONES.overdue },
      ].filter((part) => part.share > 0),
      summary: t("dashboard.hero.splitSummary", {
        month: monthName,
        paid: paidText,
        pending: pendingText,
        overdue: overdueText,
      }),
    }
    // `text` closes over locale and currency, both covered below.
  }, [hero, owedMinor, exponent, locale, monthName, t])

  return (
    <Panel label={t("dashboard.hero.label")} data-slot="dashboard-hero" className={cn("pb-5", className)}>
      <div className="px-4 pt-2">
        <Amount
          value={minorToDecimal(owedMinor, exponent)}
          currency={hero.currency}
          locale={locale}
          size="hero"
          precision={precision}
          // A rule is money asked for or settled; when nothing valued is owed here it has no figure to sit under.
          rule={kvit ? "double" : hero.outstanding ? "single" : "none"}
          className="text-[32px]"
        />
        <p className="text-muted-foreground mt-1 text-sm">
          {kvit
            ? t("dashboard.hero.kvit")
            : [
                hero.outstanding ? tCount(t, "dashboard.hero.count", hero.outstanding.count) : null,
                hero.noneOverdue ? t("dashboard.hero.noneOverdue") : null,
              ]
                .filter(Boolean)
                .join(" · ")}
        </p>
      </div>

      {split ? (
        <div className="mt-5 px-4">
          <div
            role="img"
            aria-label={split.summary}
            className="flex h-2 gap-0.5 overflow-hidden rounded-full bg-(--neutral-6)"
          >
            {split.parts.map((part) => (
              <span
                key={part.key}
                data-segment={part.key}
                className={cn("block h-full min-w-1.5 rounded-full", part.className)}
                style={{ flexGrow: part.share, flexBasis: 0 }}
              />
            ))}
          </div>
          <ul className="text-muted-foreground mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-xs">
            {split.parts.map((part) => (
              <li key={part.key} className="inline-flex items-center gap-1.5">
                <span aria-hidden="true" className={cn("size-1.5 rounded-full", part.className)} />
                <span>{part.label}</span>
                <span className="text-foreground font-medium tabular-nums">{part.amount}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {hero.others.length > 0 ? (
        <ul className="text-muted-foreground border-hairline mx-4 mt-4 space-y-0.5 border-t pt-3 text-xs">
          {hero.others.map((other) => (
            <li key={other.currency}>
              {t("dashboard.hero.otherOutstanding", {
                amount: formatAmountText(other.outstanding.amount, other.currency, locale, precisionOf(other.outstanding)),
              })}
              {other.overdue
                ? ` · ${t("dashboard.hero.otherOverdue", {
                    amount: formatAmountText(other.overdue.amount, other.currency, locale, precisionOf(other.overdue)),
                  })}`
                : ""}
            </li>
          ))}
        </ul>
      ) : null}
    </Panel>
  )
}
