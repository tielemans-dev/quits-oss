import type { DocumentTaxId, BuyerSnapshot } from "@quits/contracts/documents"
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

export function buyerAddress(buyer: BuyerSnapshot | null | undefined): string[] {
  return [buyer?.address, [buyer?.zip, buyer?.city, buyer?.state].filter(Boolean).join(" "), buyer?.country].filter((value): value is string => Boolean(value))
}

/** PDF postal presentation. Public payment-page country presentation is managed separately. */
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
