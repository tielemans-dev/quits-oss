import { useMemo } from "react"
import { formatCurrency, formatDate, formatNumber } from "../../lib/i18n/format"
import { useI18n } from "../../lib/i18n/react"

/**
 * Money, dates and quantities for a document, in the page's locale and the document's timezone.
 * Dates are written the short way ("Mar 9, 2026", "9. mar. 2026") to fit the page's compact blocks.
 */
export function useDocumentFormat(timeZone: string) {
  const { locale } = useI18n()

  return useMemo(
    () => ({
      money(amount: number, currency: string) {
        try {
          return formatCurrency(amount, currency, locale)
        } catch {
          // A currency code Intl rejects must not take the whole page down.
          return `${amount.toFixed(2)} ${currency}`
        }
      },
      date(value: Date | string) {
        return formatDate(value, locale, timeZone, { month: "short" })
      },
      number(value: number) {
        return formatNumber(value, locale)
      },
    }),
    [locale, timeZone]
  )
}
