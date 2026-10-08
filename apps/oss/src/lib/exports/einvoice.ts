import { getDocumentArtifactStore } from "../runtime/services"
import { hashBytes } from "../../domain/documents/hash"
import { creditedGroupsSchema } from "@quits/contracts/pricing"
import { vatGroupKey, percentageToFraction } from "@quits/shared/pricing"
import { frozenVatGroups } from "../../domain/documents/frozen-vat-groups"
import {
  parseBuyerSnapshot,
  parseSellerSnapshot,
  type BuyerSnapshot,
  type SellerSnapshot,
} from "@quits/contracts/documents"
import type { EinvoiceDocumentKind, EinvoiceExportResult } from "@quits/contracts/exports"
import { normalizeBic, normalizeIban, type BankAccountSnapshot } from "@quits/contracts/payment-details"
import { prisma } from "../db"
import { formatIsoDate, safeFileName } from "./format"
import {
  electronicAddressFromVat,
  explicitElectronicAddress,
  legalIdentifier,
  parseFreeTextAddress,
  toCountryCode,
  vatIdentifier,
  type TaxIdLike,
} from "./parties"
import {
  PAYMENT_MEANS_BANK_ACCOUNT,
  PAYMENT_MEANS_CREDIT_TRANSFER,
  PAYMENT_MEANS_SEPA_CREDIT_TRANSFER,
  buildUblDocument,
  validateEinvoice,
  type EinvoiceDocument,
  type EinvoiceParty,
  type EinvoicePayment,
} from "./ubl"

export class EinvoiceArtifactUnavailable extends Error {
  readonly code = "stored_artifact_unavailable"
  constructor() { super("Stored UBL artifact unavailable. Issued documents cannot be rendered again.") }
}

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
    legalId: legalIdentifier(taxIds, countryCode, vatId),
    electronicAddress: electronicAddressFromVat(vatId),
    email: source.snapshot?.companyEmail || source.settings?.companyEmail || null,
  }
}

/**
 * The bank transfer instructions of an invoice, from the bank account frozen on it. Which account
 * can be sent depends on where the buyer pays from:
 *
 * - Danish seller and buyer (DK-R-005/006 apply): the reg.nr. and account number as code 42, else
 *   an IBAN with BIC as code 58 (EUR) or 42 (other currencies). Code 42 needs the account and its
 *   branch, so an IBAN without a BIC cannot be sent in a non-EUR invoice.
 * - Any other pair: only an IBAN travels, as code 58 (SEPA) in EUR and code 30 otherwise. The Danish
 *   reg.nr. and account number are no use to a foreign bank, so they are left out.
 */
export function buildEinvoicePayment(
  bankAccount: BankAccountSnapshot | null | undefined,
  context: {
    /** The payer's remittance information: the invoice's payment reference. */
    reference: string
    currency: string
    sellerCountry: string | null
    buyerCountry: string | null
  }
): EinvoicePayment | null {
  const { reference, currency } = context
  const iban = normalizeIban(bankAccount?.iban ?? "")
  const bic = normalizeBic(bankAccount?.bic ?? "") || null
  const regNumber = bankAccount?.regNumber?.trim() ?? ""
  const accountNumber = bankAccount?.accountNumber?.trim() ?? ""
  const accountName = bankAccount?.accountHolder?.trim() || null
  const isEur = currency.trim().toUpperCase() === "EUR"
  const domestic = context.sellerCountry === "DK" && context.buyerCountry === "DK"

  if (domestic && regNumber && accountNumber) {
    return { meansCode: PAYMENT_MEANS_BANK_ACCOUNT, accountId: accountNumber, accountName, branchId: regNumber, reference }
  }
  if (!iban) return null
  if (isEur) {
    return { meansCode: PAYMENT_MEANS_SEPA_CREDIT_TRANSFER, accountId: iban, accountName, branchId: bic, reference }
  }
  if (!domestic) {
    return { meansCode: PAYMENT_MEANS_CREDIT_TRANSFER, accountId: iban, accountName, branchId: bic, reference }
  }
  return bic
    ? { meansCode: PAYMENT_MEANS_BANK_ACCOUNT, accountId: iban, accountName, branchId: bic, reference }
    : null
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
    legalId: legalIdentifier(taxIds, countryCode, vatId),
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
    const sellerSnapshot = parseSellerSnapshot(invoice.sellerSnapshot)
    const sellerParty = buildSellerParty({
      snapshot: sellerSnapshot,
      settings: seller.settings,
      taxIds: seller.taxIds,
      documentCountryCode: invoice.countryCode,
    })
    const payment = buildEinvoicePayment(sellerSnapshot?.bankAccount, {
      reference: invoice.paymentReference?.trim() || invoice.number,
      currency: invoice.currency,
      sellerCountry: sellerParty.countryCode,
      buyerCountry: buyer.countryCode,
    })

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
      seller: sellerParty,
      buyer,
      ...(payment ? { payment } : {}),
      calculationVersion: invoice.calculationVersion,
      frozenGroups: invoice.calculationVersion === "v2" ? frozenVatGroups(invoice) : undefined,
      lines: invoice.items.map(exportLine),
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
    calculationVersion: creditNote.calculationVersion,
    frozenGroups: creditNote.calculationVersion === "v2" ? creditedGroupsSchema.parse(creditNote.creditedGroups).map((group) => ({
      ...group.original, net: group.creditedNet, tax: group.creditedTax, gross: group.creditedGross, payableRounding: group.creditedRounding,
      netBase: group.netBase, taxBase: group.taxBase, grossBase: group.grossBase, payableRoundingBase: group.payableRoundingBase,
    })) : undefined,
    lines: creditNote.items.map(exportLine),
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
  const row = kind === "invoice" ? await prisma.invoice.findFirst({ where: { id, organizationId }, select: { status: true, number: true, artifactUblRef: true, artifactUblHash: true } }) : await prisma.creditNote.findFirst({ where: { id, organizationId }, select: { status: true, number: true, artifactUblRef: true, artifactUblHash: true } })
  if (!row) throw new EinvoiceSourceNotFound(kind, id)
  if (row.status !== "draft") {
    if (!row.artifactUblRef) throw new EinvoiceArtifactUnavailable()
    const bytes = await getDocumentArtifactStore()?.get(row.artifactUblRef)
    if (!bytes || hashBytes(bytes) !== row.artifactUblHash) throw new EinvoiceArtifactUnavailable()
    return { ok: true, filename: `${safeFileName(row.number, kind)}.xml`, xml: new TextDecoder().decode(bytes) }
  }
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

function exportLine<T extends { vatTreatment: string; vatReasonCode: string | null; vatCountry: string | null; vatRateInput?: string | null; taxRate: { toString(): string } }>(line: T) {
  return { ...line, groupKey: vatGroupKey({ treatment: line.vatTreatment, reasonCode: line.vatReasonCode, country: line.vatCountry,
    rate: line.vatRateInput ?? percentageToFraction(line.taxRate.toString()) }) }
}
