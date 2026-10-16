import type { DocumentTaxId } from "@quits/contracts/documents"
import { translate } from "../i18n/translate"
import { toCountryCode } from "../exports/parties"
import { sellerCvr, sellerPresentationTaxIds } from "./invoice-identity"

/** Seller labels follow the buyer country; buyer identifiers keep their own scheme. */
export function formatTaxIds(ids: readonly DocumentTaxId[] | undefined, locale?: string | null, buyerCountry?: string | null, momsRegistered?: boolean | null, cvrLabel?: string): string[] {
  // Seller calls pass the buyer's country; a blank stored country counts as missing, which is domestic.
  const country = buyerCountry == null ? null : buyerCountry.trim() || "DK"
  ids = country ? sellerPresentationTaxIds(ids, momsRegistered) : ids
  const cvr = sellerCvr(ids)
  const national = cvr && country ? [toCountryCode(country) === "DK" || momsRegistered !== true
    ? `${cvrLabel ?? translate("pdf.cvrNumber", locale)} ${cvr}`
    : `${translate("pdf.vatNumber", locale)} DK${cvr}`] : []
  return [...national, ...(ids ?? []).filter(id => id.value.trim() && !(national.length && sellerCvr([id]) === cvr)).map(id => {
    const scheme = id.scheme?.trim().toLowerCase() ?? ""
    const label = ["vat", "dk_vat", "eu_vat", "vat_id", "vatin", "moms", "ust", "tva", "btw"].includes(scheme)
      ? translate("pdf.vatNumber", locale) : ["cvr", "dk_cvr"].includes(scheme)
        ? translate("pdf.cvrNumber", locale) : scheme === "se"
          ? translate("pdf.seNumber", locale) : scheme.replace(/_/g, " ").toUpperCase() || translate("creditNotes.pdf.taxId", locale)
    return `${label}${["se", "cvr", "dk_cvr", "vat", "dk_vat", "eu_vat", "vat_id", "vatin", "moms", "ust", "tva", "btw"].includes(scheme) ? "" : ":"} ${id.value.trim()}`
  })]
}

export function distinctCompany(party: { name?: string | null; company?: string | null } | null | undefined): string | null {
  const company = party?.company?.trim()
  return company && company !== party?.name?.trim() ? company : null
}
