/**
 * Seller and buyer details for the credit note PDF.
 *
 * A credit note is a legal document frozen at issue time, so the parties come from the seller
 * and buyer snapshots stored on it. Current organization settings are only used for
 * presentation (logo, phone) and for credit notes issued before snapshots existed.
 */
import {
  parseBuyerSnapshot,
  parseSellerSnapshot,
  type DocumentTaxId,
} from "@quits/contracts/documents"
import { canRenderLogo } from "../documents/logo"
import { translate } from "../i18n/translate"
import type { OrgSettingsForPdf } from "../invoice-pdf"

export type CreditNotePdfContact = {
  name: string
  email?: string | null
  company?: string | null
  address?: string | null
  city?: string | null
  state?: string | null
  zip?: string | null
  country?: string | null
}

export type CreditNotePdfPartiesInput = {
  locale?: string | null
  sellerSnapshot?: unknown
  buyerSnapshot?: unknown
  /** The contact as it is now, used when the credit note has no buyer snapshot. */
  contact: CreditNotePdfContact
}

export type CreditNotePdfSeller = {
  name: string
  email: string | null
  phone: string | null
  address: string | null
  /** Formatted tax identifiers, e.g. "VAT no.: DK12345678". */
  taxIds: string[]
  logo: string | null
}

export type CreditNotePdfBuyer = {
  name: string
  company: string | null
  email: string | null
  /** Address lines in print order. */
  lines: string[]
  taxIds: string[]
}

const VAT_SCHEMES = new Set(["vat", "eu_vat", "vat_id", "vatin", "moms", "ust", "tva", "btw"])

function formatTaxIds(taxIds: readonly DocumentTaxId[] | undefined, locale: string | null | undefined) {
  return (taxIds ?? []).flatMap((taxId) => {
    const value = taxId.value.trim()
    if (!value) return []
    const scheme = taxId.scheme?.trim() ?? ""
    const normalized = scheme.toLowerCase()
    const label = VAT_SCHEMES.has(normalized)
      ? translate("creditNotes.pdf.vatNumber", locale)
      : normalized === "cvr"
        ? translate("creditNotes.pdf.cvrNumber", locale)
        : scheme
          ? scheme.replace(/_/g, " ").toUpperCase()
          : translate("creditNotes.pdf.taxId", locale)
    return [`${label}: ${value}`]
  })
}

export function creditNotePdfParties(
  creditNote: CreditNotePdfPartiesInput,
  org: OrgSettingsForPdf
): { seller: CreditNotePdfSeller; buyer: CreditNotePdfBuyer } {
  const locale = creditNote.locale ?? org.locale
  const sellerSnapshot = parseSellerSnapshot(creditNote.sellerSnapshot)
  const buyerSnapshot = parseBuyerSnapshot(creditNote.buyerSnapshot)

  const seller: CreditNotePdfSeller = sellerSnapshot
    ? {
        name: sellerSnapshot.companyName || org.companyName || "Quits",
        email: sellerSnapshot.companyEmail ?? null,
        address: sellerSnapshot.companyAddress ?? null,
        taxIds: formatTaxIds(sellerSnapshot.taxIds, locale),
        phone: org.companyPhone ?? null,
        logo: canRenderLogo(org.companyLogo) ? org.companyLogo : null,
      }
    : {
        name: org.companyName || "Quits",
        email: org.companyEmail ?? null,
        address: org.companyAddress ?? null,
        taxIds: [],
        phone: org.companyPhone ?? null,
        logo: canRenderLogo(org.companyLogo) ? org.companyLogo : null,
      }

  const party = buyerSnapshot
    ? { ...buyerSnapshot, name: buyerSnapshot.name || creditNote.contact.name }
    : creditNote.contact
  const cityLine = [party.city, party.state, party.zip].filter(Boolean).join(", ")
  const buyer: CreditNotePdfBuyer = {
    name: party.name,
    company: party.company ?? null,
    email: party.email ?? null,
    lines: [party.address, cityLine, party.country].filter((line): line is string => Boolean(line)),
    taxIds: formatTaxIds(buyerSnapshot?.taxIds, locale),
  }

  return { seller, buyer }
}
