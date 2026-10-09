import type { DocumentTaxId, BuyerSnapshot } from "@quits/contracts/documents"

/** A Danish national identifier, whether stored as CVR or a Danish VAT identifier. */
export function sellerCvr(ids: readonly DocumentTaxId[] | undefined): string | null {
  for (const id of ids ?? []) {
    if (id.countryCode && id.countryCode !== "DK") continue
    const scheme = id.scheme?.toLowerCase()
    const value = id.value.replace(/[\s.\-/]/g, "").toUpperCase()
    if ((scheme === "cvr" || scheme === "dk_cvr" || (scheme === "vat" && (id.countryCode === "DK" || value.startsWith("DK")))) && /^(DK)?\d{8}$/.test(value)) return value.replace(/^DK/, "")
  }
  return null
}

export function invoiceTaxIds(ids: readonly DocumentTaxId[] | undefined): string[] {
  const cvr = sellerCvr(ids)
  return cvr ? [`CVR: ${cvr}`] : (ids ?? []).filter(id => id.value.trim()).map(id => `${id.scheme?.toUpperCase() ?? "ID"}: ${id.value}`)
}

export function buyerAddress(buyer: BuyerSnapshot | null | undefined): string[] {
  return [buyer?.address, [buyer?.zip, buyer?.city, buyer?.state].filter(Boolean).join(" "), buyer?.country].filter((value): value is string => Boolean(value))
}
