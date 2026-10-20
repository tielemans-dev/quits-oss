import type { DocumentTaxId, BuyerSnapshot } from "@quits/contracts/documents"
import { countryName } from "../country-names"
import { normalizeLocale } from "../i18n/locale"

/** A Danish national identifier, whether stored as CVR or a Danish VAT identifier. */
export function sellerCvr(ids: readonly DocumentTaxId[] | undefined): string | null {
  for (const id of ids ?? []) {
    if (id.countryCode && id.countryCode !== "DK") continue
    const scheme = id.scheme?.trim().toLowerCase()
    const value = id.value.replace(/[\s.\-/]/g, "").toUpperCase()
    if ((scheme === "cvr" || scheme === "dk_cvr" || scheme === "dk_vat" || (scheme === "vat" && (id.countryCode === "DK" || value.startsWith("DK")))) && /^(DK)?\d{8}$/.test(value)) return value.replace(/^DK/, "")
  }
  return null
}

const VAT_SCHEMES = new Set(["vat", "dk_vat", "eu_vat", "vat_id", "vatin", "moms", "ust", "tva", "btw"])

/** Explicit non-registration cannot claim a VAT identifier, including migrated bare VAT IDs. */
export function sellerPresentationTaxIds(ids: readonly DocumentTaxId[] | undefined, momsRegistered?: boolean | null) {
  return momsRegistered === false
    ? ids?.filter(id => !VAT_SCHEMES.has(id.scheme?.trim().toLowerCase() ?? ""))
    : ids
}

export function invoiceTaxIds(taxIds: readonly DocumentTaxId[] | undefined, cvrLabel = "CVR-nr.", momsRegistered?: boolean | null): string[] {
  const ids = sellerPresentationTaxIds(taxIds, momsRegistered)
  const cvr = sellerCvr(ids)
  return cvr ? [`${cvrLabel} ${cvr}`] : (ids ?? []).filter(id => id.value.trim()).map(id => `${id.scheme?.toUpperCase() ?? "ID"}: ${id.value}`)
}

/** A seller's free-text postal address, one line for each line the seller wrote. */
export function sellerAddressLines(address: string | null | undefined): string[] {
  return (address ?? "").split(/\r?\n/).map(line => line.trim()).filter(Boolean)
}

export function buyerAddress(buyer: BuyerSnapshot | null | undefined, locale: string | null | undefined = "en-US"): string[] {
  return [buyer?.address, [buyer?.zip, buyer?.city, buyer?.state].filter(Boolean).join(" "), countryName(buyer?.country, locale)].filter((value): value is string => Boolean(value))
}

/** PDF postal presentation. */
export function pdfBuyerAddress(buyer: Omit<BuyerSnapshot, "email">, locale?: string | null): string[] {
  const countryCode = buyer.country?.trim().toUpperCase()
  const country = countryCode && /^[A-Z]{2}$/.test(countryCode)
    ? new Intl.DisplayNames([normalizeLocale(locale)], { type: "region" }).of(countryCode)
    : buyer.country
  const locality = countryCode === "DK"
    ? [buyer.zip, buyer.city].filter(Boolean).join(" ")
    : [buyer.city, buyer.state, buyer.zip].filter(Boolean).join(", ")
  return [buyer.address, locality, country].filter((line): line is string => Boolean(line))
}
