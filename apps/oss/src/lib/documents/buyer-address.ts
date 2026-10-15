import type { BuyerSnapshot } from "@quits/contracts/documents"
import { toCountryCode } from "../exports/parties"
import { normalizeLocale } from "../i18n/locale"

/** Postal order shared with QUI-61's PDF fix; domestic country is redundant on detail pages. */
export function detailBuyerAddress(buyer: Omit<BuyerSnapshot, "email">, sellerCountry: string, locale: string): string[] {
  const countryCode = toCountryCode(buyer.country)
  const country = countryCode && /^[A-Z]{2}$/.test(countryCode)
    ? new Intl.DisplayNames([normalizeLocale(locale)], { type: "region" }).of(countryCode)
    : buyer.country?.trim()
  const locality = countryCode === "DK" || (!buyer.country?.trim() && sellerCountry === "DK")
    ? [buyer.zip, buyer.city].filter(Boolean).join(" ")
    : [buyer.city, buyer.state, buyer.zip].filter(Boolean).join(", ")
  return [buyer.address, locality, countryCode === sellerCountry.trim().toUpperCase() ? null : country].filter((line): line is string => Boolean(line))
}
