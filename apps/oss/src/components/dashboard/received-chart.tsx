import { useState } from "react"

import { useI18n } from "../../lib/i18n/react"
import { cn } from "../../lib/utils"
import { formatAmountText } from "../kvit/amount-format"
import { Panel } from "../kvit/panel"
import { DoubleRule } from "./double-rule"
import { formatChartMonth } from "./format-relative"
import { tCount } from "./i18n"
import { streakVisible, type ChartModel } from "./summary-model"

/**
 * Twelve months of received money in the base currency, as plain bars: no axis, no gridlines, the
 * current month in Kvit-blå and the rest in a tint of it. A bar is a button, so hovering or
 * tabbing to one reads its month and amount in the line above the chart. The streak sits under it
 * as one quiet line, since it is the same story: money arriving on time.
 */
export function ReceivedChart({ chart, streak }: { chart: ChartModel; streak: number }) {
  const { t, locale } = useI18n()
  const [active, setActive] = useState<number | null>(null)

  const current = chart.months.length - 1
  const shown = chart.months[active ?? current]!
  const max = Math.max(...chart.months.map((month) => month.value), 0)
  const amountText = (amount: string) => formatAmountText(amount, chart.currency, locale, chart.precision)
  const monthText = (month: string) => formatChartMonth(month, "long", locale)

  return (
    <Panel
      label={t("dashboard.chart.title")}
      action={
        chart.hasData ? (
          <span className="text-muted-foreground text-xs">
            {t("dashboard.chart.total", { amount: amountText(chart.total) })}
          </span>
        ) : undefined
      }
      className="@container"
    >
      <div className="px-4 pt-1 pb-4">
        <p className="text-muted-foreground min-h-5 text-xs" aria-hidden="true">
          {chart.hasData ? (
            shown.amount !== null ? (
              <>
                <span className="text-foreground font-semibold">{amountText(shown.amount)}</span>
                {" · "}
                {monthText(shown.month)}
                {(active ?? current) === current ? ` · ${t("dashboard.chart.current")}` : ""}
              </>
            ) : (
              t("dashboard.chart.monthEmpty", { month: monthText(shown.month) })
            )
          ) : (
            t("dashboard.chart.empty", { currency: chart.currency })
          )}
        </p>

        <ul
          className="mt-3 flex h-32 items-end gap-1 @sm:gap-1.5"
          onMouseLeave={() => setActive(null)}
        >
          {chart.months.map((month, index) => {
            const height = chart.hasData && month.value > 0 && max > 0 ? Math.max((month.value / max) * 100, 4) : 0
            return (
              <li key={month.month} className="flex h-full min-w-0 flex-1">
                <button
                  type="button"
                  aria-label={
                    month.amount !== null
                      ? t("dashboard.chart.barLabel", { month: monthText(month.month), amount: amountText(month.amount) })
                      : t("dashboard.chart.monthEmpty", { month: monthText(month.month) })
                  }
                  data-month={month.month}
                  data-current={month.isCurrent || undefined}
                  onMouseEnter={() => setActive(index)}
                  onFocus={() => setActive(index)}
                  onBlur={() => setActive(null)}
                  className="group focus-visible:ring-ring flex h-full w-full flex-col justify-end rounded-[5px] outline-none focus-visible:ring-2"
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "block w-full rounded-[5px] transition-colors duration-150",
                      height === 0
                        ? "bg-foreground/10 h-0.5"
                        : month.isCurrent
                          ? "bg-brand"
                          : "bg-brand/25 group-hover:bg-brand/45 group-focus-visible:bg-brand/45"
                    )}
                    style={height === 0 ? undefined : { height: `${height}%` }}
                  />
                </button>
              </li>
            )
          })}
        </ul>

        <ul aria-hidden="true" className="mono-label mt-2 flex gap-1 text-[10px] @sm:gap-1.5">
          {chart.months.map((month) => (
            <li
              key={month.month}
              className={cn("min-w-0 flex-1 text-center", month.isCurrent && "text-foreground font-semibold")}
            >
              {formatChartMonth(month.month, "short", locale).replace(".", "")}
            </li>
          ))}
        </ul>

        {chart.hasOtherCurrencies ? (
          <p className="text-muted-foreground mt-3 text-xs">{t("dashboard.chart.otherCurrencies")}</p>
        ) : null}
      </div>

      {streakVisible(streak) ? (
        <p className="border-hairline text-muted-foreground flex items-center gap-2.5 border-t px-4 py-3 text-sm">
          <DoubleRule className="text-foreground" />
          <span>{tCount(t, "dashboard.streak", streak)}</span>
        </p>
      ) : null}
    </Panel>
  )
}
