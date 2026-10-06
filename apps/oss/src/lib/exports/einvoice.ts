import {
  parseBuyerSnapshot,
  parseSellerSnapshot,
  type BuyerSnapshot,
  type SellerSnapshot,
} from "@yaip/contracts/documents"
import type { EinvoiceDocumentKind, EinvoiceExportResult } from "@yaip/contracts/exports"
import { prisma } from "../db"
import { formatIsoDate, safeFileName } from "./format"
import {
  companyIdentifier,
  electronicAddressFromVat,
  explicitElectronicAddress,
  parseFreeTextAddress,
  toCountryCode,
  vatIdentifier,
  type TaxIdLike,
} from "./parties"
import { buildUblDocument, validateEinvoice, type EinvoiceDocument, type EinvoiceParty } from "./ubl"

export class EinvoiceSourceNotFound extends Error {
  constructor(readonly kind: EinvoiceDocumentKind, readonly id: string) {
    super(kind === "invoice" ? "Invoice not found" : "Credit note not found")
  }
}

const contactSelect = {
  name: true,
  email: true,
  company: true,
  address: true,
  city: true,
  state: true,
  zip: true,
  country: true,
  taxId: true,
  peppolEndpointId: true,
  peppolEndpointScheme: true,
  taxIds: { select: { scheme: true, value: true, countryCode: true, isPrimary: true } },
} as const

type ContactRow = {
  name: string
  email: string | null
  company: string | null
  address: string | null
  city: string | null
  state: string | null
  zip: string | null
  country: string | null
  taxId: string | null
  peppolEndpointId: string | null
  peppolEndpointScheme: string | null
  taxIds: Array<{ scheme: string; value: string; countryCode: string | null; isPrimary: boolean }>
}

type SellerSource = {
  snapshot: SellerSnapshot | null
  settings: {
    companyName: string | null
    companyAddress: string | null
    companyEmail: string | null
    countryCode: string
  } | null
  taxIds: TaxIdLike[]
  documentCountryCode: string
}

function primaryFirst<T extends { isPrimary: boolean }>(rows: T[]) {
  return [...rows].sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary))
}

/** Seller party: the frozen snapshot first, the current organization settings as a fallback. */
export function buildSellerParty(source: SellerSource): EinvoiceParty {
  const countryCode =
    toCountryCode(source.documentCountryCode) ?? toCountryCode(source.settings?.countryCode)
  const addressText = source.snapshot?.companyAddress || source.settings?.companyAddress || null
  const taxIds = source.snapshot?.taxIds?.length ? source.snapshot.taxIds : source.taxIds
  const vatId = vatIdentifier(taxIds, countryCode)
  return {
    ...parseFreeTextAddress(addressText, countryCode),
    name: source.snapshot?.companyName || source.settings?.companyName || null,
    countryCode,
    vatId,
    companyId: companyIdentifier(taxIds),
    electronicAddress: electronicAddressFromVat(vatId),
    email: source.snapshot?.companyEmail || source.settings?.companyEmail || null,
  }
}

/** Buyer party: snapshot values first, the live contact for anything missing and for the endpoint. */
export function buildBuyerParty(snapshot: BuyerSnapshot | null, contact: ContactRow): EinvoiceParty {
  const pick = (key: "company" | "address" | "city" | "state" | "zip" | "country" | "email") =>
    snapshot?.[key]?.trim() || contact[key]?.trim() || null
  const countryCode = toCountryCode(pick("country"))
  const taxIds: TaxIdLike[] = snapshot?.taxIds?.length
    ? snapshot.taxIds
    : contact.taxIds.length
      ? primaryFirst(contact.taxIds)
      : contact.taxId
        ? [{ value: contact.taxId }]
        : []
  // A bare tax ID on a contact is the VAT number in practice; treat unschemed values as VAT.
  const vatCandidates = taxIds.map((taxId) => ({ ...taxId, scheme: taxId.scheme || "vat" }))
  const vatId = vatIdentifier(vatCandidates, countryCode)
  const address = {
    street: pick("address"),
    additionalStreet: null,
    city: pick("city"),
    postalZone: pick("zip"),
    region: pick("state"),
  }

  return {
    ...address,
    name: pick("company") || snapshot?.name?.trim() || contact.name,
    countryCode,
    vatId,
    companyId: companyIdentifier(taxIds),
    electronicAddress:
      explicitElectronicAddress(contact.peppolEndpointId, contact.peppolEndpointScheme) ??
      electronicAddressFromVat(vatId),
    email: pick("email"),
  }
}

async function loadSellerContext(organizationId: string) {
  const [settings, taxIds] = await Promise.all([
    prisma.orgSettings.findUnique({
      where: { organizationId },
      select: { companyName: true, companyAddress: true, companyEmail: true, countryCode: true },
    }),
    prisma.organizationTaxId.findMany({
      where: { organizationId },
      select: { scheme: true, value: true, countryCode: true, isPrimary: true },
    }),
  ])
  return { settings, taxIds: primaryFirst(taxIds) }
}

/** Loads an issued invoice or credit note into the e-invoice model. */
export async function loadEinvoiceDocument(
  organizationId: string,
  kind: EinvoiceDocumentKind,
  id: string
): Promise<EinvoiceDocument> {
  const seller = await loadSellerContext(organizationId)

  if (kind === "invoice") {
    const invoice = await prisma.invoice.findFirst({
      where: { id, organizationId },
      include: { contact: { select: contactSelect }, items: { orderBy: { sortOrder: "asc" } } },
    })
    if (!invoice) throw new EinvoiceSourceNotFound(kind, id)
    const buyer = buildBuyerParty(parseBuyerSnapshot(invoice.buyerSnapshot), invoice.contact)

    return {
      kind,
      issued: invoice.status !== "draft",
      number: invoice.number,
      issueDate: formatIsoDate(invoice.issueDate, invoice.timezone),
      dueDate: formatIsoDate(invoice.dueDate, invoice.timezone),
      deliveryDate: invoice.supplyDate ? formatIsoDate(invoice.supplyDate, invoice.timezone) : null,
      currency: invoice.currency,
      buyerReference: invoice.purchaseOrderRef || buyer.name,
      orderReference: invoice.purchaseOrderRef,
      billingReference: null,
      note: invoice.notes,
      seller: buildSellerParty({
        snapshot: parseSellerSnapshot(invoice.sellerSnapshot),
        settings: seller.settings,
        taxIds: seller.taxIds,
        documentCountryCode: invoice.countryCode,
      }),
      buyer,
      lines: invoice.items,
      storedGross: invoice.totalGross,
      amountPaid: invoice.amountPaid,
    }
  }

  const creditNote = await prisma.creditNote.findFirst({
    where: { id, organizationId },
    include: {
      contact: { select: contactSelect },
      items: { orderBy: { sortOrder: "asc" } },
      invoice: {
        select: { number: true, issueDate: true, status: true, purchaseOrderRef: true, timezone: true },
      },
    },
  })
  if (!creditNote) throw new EinvoiceSourceNotFound(kind, id)
  const buyer = buildBuyerParty(parseBuyerSnapshot(creditNote.buyerSnapshot), creditNote.contact)
  const invoice = creditNote.invoice

  return {
    kind,
    issued: creditNote.status !== "draft",
    number: creditNote.number,
    issueDate: formatIsoDate(creditNote.issueDate, creditNote.timezone),
    dueDate: null,
    deliveryDate: null,
    currency: creditNote.currency,
    buyerReference: invoice.purchaseOrderRef || buyer.name,
    orderReference: invoice.purchaseOrderRef,
    billingReference:
      invoice.status === "draft"
        ? null
        : { number: invoice.number, issueDate: formatIsoDate(invoice.issueDate, invoice.timezone) },
    note: creditNote.reason,
    seller: buildSellerParty({
      snapshot: parseSellerSnapshot(creditNote.sellerSnapshot),
      settings: seller.settings,
      taxIds: seller.taxIds,
      documentCountryCode: creditNote.countryCode,
    }),
    buyer,
    lines: creditNote.items,
    storedGross: creditNote.totalGross,
    amountPaid: 0,
  }
}

/** Validates and renders a Peppol BIS Billing 3.0 document, or lists the data it is missing. */
export async function exportEinvoice(
  organizationId: string,
  kind: EinvoiceDocumentKind,
  id: string
): Promise<EinvoiceExportResult> {
  const document = await loadEinvoiceDocument(organizationId, kind, id)
  const missing = validateEinvoice(document)
  if (missing.length > 0) {
    return { ok: false, missing }
  }
  return {
    ok: true,
    filename: `${safeFileName(document.number, kind)}.xml`,
    xml: buildUblDocument(document),
  }
}
