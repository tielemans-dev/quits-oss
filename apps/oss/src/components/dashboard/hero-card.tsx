import { useMemo } from "react"

import { useI18n } from "../../lib/i18n/react"
import { cn } from "../../lib/utils"
import { Amount } from "../kvit/amount"
import { formatAmountText, minorToDecimal } from "../kvit/amount-format"
import { MonoLabel } from "../kvit/mono-label"
import { tCount } from "./i18n"
import { precisionOf, toMinor, type HeroModel } from "./summary-model"
import { useCountUp } from "./use-count-up"

/**
 * Overdue on the ink card: a coral for the dot and the bar segment only (12.5:1 on ink, kept as a
 * graphic so the card has one alarm colour). Money received this month is the Settled green
 * (8.3:1 on ink, 7.2:1 on the dark-theme card). Text on the card is paper at 90% or more.
 */
const OVERDUE_TONE = "bg-[#ffbfb5]"

/**
 * The Outstanding card, on the ink hero surface: how much money is on its way to me. The figure sits on a single rule while
 * money is asked for, and on both once nothing is owed (the signature). Under it, quietly, what is
 * overdue, how this month splits, and any other currency on a line of its own.
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
  const shown = useCountUp(owedMinor)
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
        { key: "paid", share: paid, label: t("dashboard.hero.legendPaid", { month: monthName }), amount: paidText, className: "bg-settled" },
        { key: "pending", share: pending, label: t("dashboard.hero.legendPending"), amount: pendingText, className: "bg-white/40" },
        { key: "overdue", share: overdue, label: t("dashboard.hero.legendOverdue"), amount: overdueText, className: OVERDUE_TONE },
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
    <section
      data-slot="dashboard-hero"
      className={cn(
        "bg-hero text-hero-foreground relative isolate overflow-hidden rounded-xl p-5 shadow-[0_18px_44px_-24px_rgb(11_11_12/55%)] sm:p-6 dark:border dark:border-hairline dark:shadow-none",
        className
      )}
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute -top-28 -right-16 -z-10 size-80 rounded-full bg-[radial-gradient(closest-side,rgb(255_255_255/10%),transparent)]"
      />
      <MonoLabel as="h2" className="text-hero-foreground/90">
        {t("dashboard.hero.label")}
      </MonoLabel>

      <div className="mt-3">
        <Amount
          value={minorToDecimal(shown, exponent)}
          currency={hero.currency}
          locale={locale}
          size="hero"
          precision={precision}
          // A rule is money asked for or settled; when nothing valued is owed here it has no figure to sit under.
          rule={kvit ? "double" : hero.outstanding ? "single" : "none"}
          className="text-[2.4rem] sm:text-6xl"
        />
      </div>

      <div className="text-hero-foreground/90 mt-1 space-y-0.5 text-sm">
        {kvit ? (
          <p>{t("dashboard.hero.kvit")}</p>
        ) : (
          <>
            {hero.outstanding ? (
              <p>{tCount(t, "dashboard.hero.count", hero.outstanding.count)}</p>
            ) : null}
            {hero.overdue ? (
              <p className="text-hero-foreground">
                <span aria-hidden="true" className={cn("mr-2 inline-block size-1.5 rounded-full align-middle", OVERDUE_TONE)} />
                {tCount(t, "dashboard.hero.overdue", hero.overdue.bucket.count, {
                  amount: text(hero.overdue.bucket.amount),
                })}
                {hero.overdue.oldestDaysOverdue !== null && hero.overdue.oldestDaysOverdue > 0 ? (
                  <span className="text-hero-foreground/90">
                    {" · "}
                    {tCount(t, "dashboard.hero.oldest", hero.overdue.oldestDaysOverdue, {
                      days: hero.overdue.oldestDaysOverdue,
                    })}
                  </span>
                ) : null}
              </p>
            ) : hero.noneOverdue ? (
              <p>{t("dashboard.hero.noneOverdue")}</p>
            ) : null}
          </>
        )}
      </div>

      {split ? (
        <div className="mt-5">
          <div
            role="img"
            aria-label={split.summary}
            className="flex h-2 gap-0.5 overflow-hidden rounded-full bg-white/15"
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
          <ul className="text-hero-foreground/90 mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-xs">
            {split.parts.map((part) => (
              <li key={part.key} className="inline-flex items-center gap-1.5">
                <span aria-hidden="true" className={cn("size-1.5 rounded-full", part.className)} />
                <span>{part.label}</span>
                <span className="font-semibold">{part.amount}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {hero.others.length > 0 ? (
        <ul className="text-hero-foreground/90 mt-4 space-y-0.5 border-t border-white/15 pt-3 text-xs">
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
    </section>
  )
}
