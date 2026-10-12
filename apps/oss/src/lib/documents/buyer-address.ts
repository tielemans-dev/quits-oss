import type { BuyerSnapshot } from "@quits/contracts/documents"
import { normalizeLocale } from "../i18n/locale"

/** Postal order shared with QUI-61's PDF fix; domestic country is redundant on detail pages. */
export function detailBuyerAddress(buyer: Omit<BuyerSnapshot, "email">, sellerCountry: string, locale: string): string[] {
  const countryCode = buyer.country?.trim().toUpperCase()
  const country = countryCode && /^[A-Z]{2}$/.test(countryCode)
    ? new Intl.DisplayNames([normalizeLocale(locale)], { type: "region" }).of(countryCode)
    : buyer.country
  const locality = countryCode === "DK" || (!countryCode && sellerCountry === "DK")
    ? [buyer.zip, buyer.city].filter(Boolean).join(" ")
    : [buyer.city, buyer.state, buyer.zip].filter(Boolean).join(", ")
  return [buyer.address, locality, countryCode === sellerCountry.trim().toUpperCase() ? null : country].filter((line): line is string => Boolean(line))
}
