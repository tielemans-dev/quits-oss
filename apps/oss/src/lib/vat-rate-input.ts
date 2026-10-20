import { fractionToPercentage, percentageToFraction } from "@quits/shared/pricing"
import { normalizeLocale } from "./i18n/locale"

function decimalSeparator(locale?: string | null) {
  return new Intl.NumberFormat(normalizeLocale(locale)).formatToParts(1.5).find(part => part.type === "decimal")?.value ?? "."
}

/** A stored VAT fraction as the percentage a person types: "0.25" is "25", "0.125" is "12,5" in Danish. Other text is kept. */
export function vatFractionToPercentText(fraction: string, locale?: string | null): string {
  const value = fraction.trim()
  if (!/^\d+(\.\d+)?$/.test(value)) return fraction
  return fractionToPercentage(value).replace(".", decimalSeparator(locale))
}

/** The stored fraction for a typed percentage, with a comma or point decimal; null when the text is not one. */
export function vatPercentTextToFraction(text: string): string | null {
  const value = text.trim().replace(",", ".")
  if (!/^\d+(\.\d*)?$/.test(value)) return null
  return percentageToFraction(value.replace(/\.$/, ""))
}
