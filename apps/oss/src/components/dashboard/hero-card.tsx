import { useMemo } from "react"

import { useI18n } from "../../lib/i18n/react"
import { cn } from "../../lib/utils"
import { Amount } from "../kvit/amount"
import { formatAmountText, minorToDecimal } from "../kvit/amount-format"
import { tCount } from "./i18n"
import { DashboardSection } from "./section"
import { precisionOf, toMinor, type HeroModel } from "./summary-model"

/**
 * The bar's three colours, also its legend's dots: received is green because it is money in,
 * what is still on its way neutral, and overdue amber. They are graphics; the figures beside them
 * are text in ink.
 */
const TONES = { paid: "bg-settled", pending: "bg-(--neutral-22)", overdue: "bg-tone-warning" }

/**
 * Udestående: how much money is on its way to me. One figure and one sentence of what it means;
 * then how this month splits, as one bar and a row per part with its amount on the right (Stripe's
 * aging form), each amount said once and a zero said in words; and any other currency on a line of
 * its own. The attention list says what is late and by how long.
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
      ],
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
    <DashboardSection title={t("dashboard.hero.label")} data-slot="dashboard-hero" className={className}>
      <Amount
        value={minorToDecimal(owedMinor, exponent)}
        currency={hero.currency}
        locale={locale}
        size="hero"
        precision={precision}
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

      {split ? (
        <div className="mt-5">
          <div role="img" aria-label={split.summary} className="flex h-2 gap-0.5 overflow-hidden rounded-full bg-(--neutral-6)">
            {split.parts
              .filter((part) => part.share > 0)
              .map((part) => (
                <span
                  key={part.key}
                  data-segment={part.key}
                  className={cn("block h-full min-w-1.5 rounded-full", part.className)}
                  style={{ flexGrow: part.share, flexBasis: 0 }}
                />
              ))}
          </div>
          <ul className="mt-3 text-sm">
            {split.parts.map((part) => (
              <li key={part.key} className="border-hairline flex items-center gap-2.5 border-t py-2 first:border-t-0">
                <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", part.className)} />
                <span className="text-muted-foreground min-w-0 flex-1 truncate">{part.label}</span>
                {part.share > 0 ? (
                  <span className="font-medium tabular-nums">{part.amount}</span>
                ) : (
                  <span className="text-muted-foreground">{t("dashboard.hero.none")}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {hero.others.length > 0 ? (
        <ul className="text-muted-foreground border-hairline mt-2 space-y-0.5 border-t pt-3 text-xs">
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
    </DashboardSection>
  )
}
