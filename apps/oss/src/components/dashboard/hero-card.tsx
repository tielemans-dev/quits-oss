import { useMemo } from "react"

import { useI18n } from "../../lib/i18n/react"
import { cn } from "../../lib/utils"
import { Amount } from "../kvit/amount"
import { formatAmountText, minorToDecimal } from "../kvit/amount-format"
import { MonoLabel } from "../kvit/mono-label"
import { tCount } from "./i18n"
import { toMinor, type HeroModel } from "./summary-model"
import { useCountUp } from "./use-count-up"

/**
 * The Kvit-blå card: how much money is on its way to me. The figure sits on a single rule while
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
  const exponent = hero.outstanding?.exponent ?? hero.paid?.exponent ?? 2
  const owedMinor = hero.outstanding ? toMinor(hero.outstanding) : 0n
  const shown = useCountUp(owedMinor)
  const text = (amount: string) => formatAmountText(amount, hero.currency, locale)

  const split = useMemo(() => {
    if (!hero.segments) return null
    const { paid, pending, overdue } = hero.segments
    const paidText = hero.paid ? text(hero.paid.amount) : text(minorToDecimal(0n, exponent))
    const overdueText = hero.overdue ? text(hero.overdue.bucket.amount) : text(minorToDecimal(0n, exponent))
    const pendingMinor = owedMinor - (hero.overdue ? toMinor(hero.overdue.bucket) : 0n)
    const pendingText = text(minorToDecimal(pendingMinor > 0n ? pendingMinor : 0n, exponent))
    return {
      parts: [
        { key: "paid", share: paid, label: t("dashboard.hero.legendPaid", { month: monthName }), amount: paidText, className: "bg-white" },
        { key: "pending", share: pending, label: t("dashboard.hero.legendPending"), amount: pendingText, className: "bg-white/40" },
        { key: "overdue", share: overdue, label: t("dashboard.hero.legendOverdue"), amount: overdueText, className: "bg-[#ffa396]" },
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
        "bg-brand text-brand-foreground relative isolate overflow-hidden rounded-xl p-5 shadow-[0_18px_44px_-24px_rgb(59_59_240/70%)] sm:p-6 dark:shadow-none",
        className
      )}
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute -top-28 -right-16 -z-10 size-80 rounded-full bg-[radial-gradient(closest-side,rgb(255_255_255/22%),transparent)]"
      />
      <MonoLabel as="h2" className="text-brand-foreground/75">
        {t("dashboard.hero.label")}
      </MonoLabel>

      <div className="mt-3">
        <Amount
          value={minorToDecimal(shown, exponent)}
          currency={hero.currency}
          locale={locale}
          size="hero"
          rule={kvit ? "double" : "single"}
          ruleTone="current"
          className="text-[2.4rem] sm:text-6xl"
        />
      </div>

      <div className="text-brand-foreground/85 mt-1 space-y-0.5 text-sm">
        {kvit ? (
          <p>{t("dashboard.hero.kvit")}</p>
        ) : (
          <>
            {hero.outstanding ? (
              <p>{tCount(t, "dashboard.hero.count", hero.outstanding.count)}</p>
            ) : null}
            {hero.overdue ? (
              <p className="text-[#ffc3ba]">
                {tCount(t, "dashboard.hero.overdue", hero.overdue.bucket.count, {
                  amount: text(hero.overdue.bucket.amount),
                })}
                {hero.overdue.oldestDaysOverdue !== null && hero.overdue.oldestDaysOverdue > 0 ? (
                  <span className="text-brand-foreground/70">
                    {" · "}
                    {tCount(t, "dashboard.hero.oldest", hero.overdue.oldestDaysOverdue, {
                      days: hero.overdue.oldestDaysOverdue,
                    })}
                  </span>
                ) : null}
              </p>
            ) : (
              <p className="text-brand-foreground/70">{t("dashboard.hero.noneOverdue")}</p>
            )}
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
          <ul className="text-brand-foreground/80 mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-xs">
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
        <ul className="text-brand-foreground/75 mt-4 space-y-0.5 border-t border-white/15 pt-3 text-xs">
          {hero.others.map((other) => (
            <li key={other.currency}>
              {t("dashboard.hero.otherOutstanding", {
                amount: formatAmountText(other.outstanding.amount, other.currency, locale),
              })}
              {other.overdue
                ? ` · ${t("dashboard.hero.otherOverdue", {
                    amount: formatAmountText(other.overdue.amount, other.currency, locale),
                  })}`
                : ""}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}
