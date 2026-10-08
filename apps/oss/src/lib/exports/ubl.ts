import type { FrozenVatGroup } from "@quits/contracts/pricing"
import {
  PEPPOL_BIS_CUSTOMIZATION_ID,
  PEPPOL_BIS_PROFILE_ID,
  type EinvoiceDocumentKind,
  type EinvoiceMissingField,
} from "@quits/contracts/exports"
import { formatAmount, formatPlainNumber, toDecimal, type DecimalLike } from "./format"
import { findCountryModule } from "../compliance"
import {
  isValidElectronicAddress,
  isValidLegalIdentifier,
  type ElectronicAddress,
  type LegalIdentifier,
  type PostalAddress,
} from "./parties"
import { element, serializeXmlDocument, textElement, type XmlElement } from "./xml"

/** Everything a Peppol BIS Billing 3.0 party needs, already normalized. */
export type EinvoiceParty = PostalAddress & {
  name: string | null
  countryCode: string | null
  vatId: string | null
  /** Legal registration number (BT-30 / BT-47). */
  legalId: LegalIdentifier | null
  electronicAddress: ElectronicAddress | null
  email: string | null
}

/**
 * Bank transfer instructions (PEPPOL BG-16/BG-17), already resolved to what the XML carries.
 * `buildEinvoicePayment` chooses the means code and the account by seller and buyer country.
 */
export type EinvoicePayment = {
  /** UNCL 4461 payment means code (BT-81). */
  meansCode: string
  /** The account to pay (BT-84): an IBAN or a Danish account number. */
  accountId: string
  /** The account holder (BT-85). */
  accountName: string | null
  /** The bank branch (BT-86): a BIC or a Danish reg.nr. */
  branchId: string | null
  /** The payer's remittance information (BT-83): the invoice's payment reference. */
  reference: string
}

/** UNCL 4461 code 30: credit transfer, without the SEPA scheme's EUR-only rules. */
export const PAYMENT_MEANS_CREDIT_TRANSFER = "30"
/** UNCL 4461 code 42: payment to bank account (the account and its branch are both given). */
export const PAYMENT_MEANS_BANK_ACCOUNT = "42"
/** UNCL 4461 code 58: SEPA credit transfer. */
export const PAYMENT_MEANS_SEPA_CREDIT_TRANSFER = "58"

/** DK-R-005: the payment means codes allowed when supplier and customer are both Danish. */
const DK_ALLOWED_PAYMENT_MEANS = new Set(["1", "10", "31", "42", "48", "49", "50", "58", "59", "93", "97"])
/** DK-R-006: for these codes both the account and its branch are mandatory. */
const DK_PAYMENT_MEANS_NEEDING_BRANCH = new Set(["31", "42"])

export type EinvoiceLine = {
  description: string
  quantity: DecimalLike
  unitPriceNet: DecimalLike
  lineNet: DecimalLike
  taxRate: DecimalLike
  /** Quits's line tax category, e.g. "standard", "zero", "exempt". */
  taxCategory: string
  vatTreatment?: string
  groupKey?: string
}

export type EinvoiceDocument = {
  kind: EinvoiceDocumentKind
  calculationVersion?: string
  frozenGroups?: FrozenVatGroup[]
  issued: boolean
  number: string
  issueDate: string
  /** Invoices only: payment due date. */
  dueDate: string | null
  deliveryDate: string | null
  currency: string
  buyerReference: string | null
  orderReference: string | null
  /** Credit notes only: the credited invoice. */
  billingReference: { number: string; issueDate: string } | null
  note: string | null
  seller: EinvoiceParty
  buyer: EinvoiceParty
  /** Invoices only, and only when the seller has an account that can be paid from the buyer's country. */
  payment?: EinvoicePayment | null
  lines: EinvoiceLine[]
  /** Gross total stored on the document; differences to the line-derived total become rounding. */
  storedGross: DecimalLike
  amountPaid: DecimalLike
}

const NAMESPACES = {
  invoice: "urn:oasis:names:specification:ubl:schema:xsd:Invoice-2",
  creditNote: "urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2",
  cac: "urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2",
  cbc: "urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2",
} as const

/** UNCL 5305 VAT category for a line: S (standard), Z (zero rated) or E (exempt). */
export function taxCategoryCode(line: Pick<EinvoiceLine, "taxRate" | "taxCategory">): "S" | "Z" | "E" {
  if (toDecimal(line.taxRate).greaterThan(0)) return "S"
  const category = line.taxCategory.trim().toLowerCase()
  return category === "zero" || category === "zero_rated" ? "Z" : "E"
}

/** Returns the BIS data the document lacks, in a stable order; empty when it can be exported. */
export function validateEinvoice(document: EinvoiceDocument): EinvoiceMissingField[] {
  requireClassifiedVat(document)
  const missing: EinvoiceMissingField[] = []
  if (!document.issued) missing.push("document.notIssued")
  if (document.lines.length === 0) missing.push("document.lines")

  const { seller, buyer } = document
  if (!seller.name?.trim()) missing.push("seller.name")
  if (!seller.countryCode) missing.push("seller.country")
  if (!seller.street && !seller.city) missing.push("seller.address")
  if (!seller.vatId) missing.push("seller.taxId")
  // National rules such as DK-R-002 and DK-R-014 require the national registration number.
  const registration = findCountryModule(seller.countryCode)?.nationalRegistration
  if (registration?.requiredForSeller && seller.legalId?.scheme !== registration.icd) {
    missing.push("seller.legalId")
  }
  // PEPPOL-COMMON-R040 and friends also apply to a legal ID's CompanyID with a schemeID.
  if (seller.legalId && !isValidLegalIdentifier(seller.legalId)) missing.push("seller.legalIdInvalid")
  if (!seller.electronicAddress) missing.push("seller.electronicAddress")
  else if (!isValidElectronicAddress(seller.electronicAddress)) missing.push("seller.electronicAddressInvalid")

  if (!buyer.name?.trim()) missing.push("buyer.name")
  if (!buyer.countryCode) missing.push("buyer.country")
  if (!buyer.street && !buyer.city) missing.push("buyer.address")
  if (buyer.legalId && !isValidLegalIdentifier(buyer.legalId)) missing.push("buyer.legalIdInvalid")
  if (!buyer.electronicAddress) missing.push("buyer.electronicAddress")
  else if (!isValidElectronicAddress(buyer.electronicAddress)) missing.push("buyer.electronicAddressInvalid")

  // DK-R-005 and DK-R-006 apply when both the supplier and the customer are in Denmark.
  if (document.kind === "invoice" && document.payment && seller.countryCode === "DK" && buyer.countryCode === "DK") {
    const { meansCode, accountId, branchId } = document.payment
    if (!DK_ALLOWED_PAYMENT_MEANS.has(meansCode)) missing.push("seller.paymentMeansCode")
    if (DK_PAYMENT_MEANS_NEEDING_BRANCH.has(meansCode) && (!accountId.trim() || !branchId?.trim())) {
      missing.push("seller.paymentAccountBranch")
    }
  }

  if (document.kind === "creditNote" && !document.billingReference) {
    missing.push("creditNote.invoiceReference")
  }
  return missing
}

type TaxGroup = {
  category: UblTaxCategory
  rate: string
  taxable: ReturnType<typeof toDecimal>
  tax: ReturnType<typeof toDecimal>
}

export type EinvoiceTotals = {
  lineExtension: string
  taxExclusive: string
  tax: string
  taxInclusive: string
  prepaid: string
  rounding: string
  payable: string
  groups: Array<{ category: UblTaxCategory; rate: string | null; taxable: string; tax: string; reason?: string }>
}

/**
 * Totals derived from the lines so every EN 16931 business rule holds: the line extension is
 * the sum of line nets (BR-CO-10), each category's tax is its taxable amount times its rate
 * (BR-CO-17), and the payable amount is the tax-inclusive total less prepayments plus rounding
 * (BR-CO-16). Any cent difference to the stored gross total is carried as the rounding amount.
 */
export function computeEinvoiceTotals(document: EinvoiceDocument): EinvoiceTotals {
  requireClassifiedVat(document)
  if (document.calculationVersion === "v2") return frozenEinvoiceTotals(document)
  // Legacy intentionally recomputes grouped VAT: it may differ from frozen per-line tax.
  // Keep this converter byte-compatible for documents issued under legacy_per_line.
  const groups = new Map<string, TaxGroup>()
  let lineExtension = toDecimal(0)
  for (const line of document.lines) {
    const net = toDecimal(formatAmount(line.lineNet))
    lineExtension = lineExtension.plus(net)
    const category = taxCategoryCode(line)
    const rate = category === "S" ? formatPlainNumber(line.taxRate) : "0"
    const key = `${category}:${rate}`
    const group = groups.get(key) ?? { category, rate, taxable: toDecimal(0), tax: toDecimal(0) }
    group.taxable = group.taxable.plus(net)
    groups.set(key, group)
  }

  let tax = toDecimal(0)
  for (const group of groups.values()) {
    group.tax = toDecimal(formatAmount(group.taxable.times(group.rate).dividedBy(100)))
    tax = tax.plus(group.tax)
  }

  const taxInclusive = lineExtension.plus(tax)
  const prepaid = toDecimal(formatAmount(document.amountPaid))
  const storedGross = toDecimal(formatAmount(document.storedGross))
  const difference = storedGross.minus(taxInclusive)
  // Only cent-level differences are rounding; anything larger means the lines are authoritative.
  const rounding = difference.abs().lessThan(1) ? difference : toDecimal(0)
  const payable = taxInclusive.minus(prepaid).plus(rounding)

  return {
    lineExtension: formatAmount(lineExtension),
    taxExclusive: formatAmount(lineExtension),
    tax: formatAmount(tax),
    taxInclusive: formatAmount(taxInclusive),
    prepaid: formatAmount(prepaid),
    rounding: formatAmount(rounding),
    payable: formatAmount(payable),
    groups: [...groups.values()]
      .sort((a, b) => a.category.localeCompare(b.category) || Number(b.rate) - Number(a.rate))
      .map((group) => ({
        category: group.category,
        rate: group.rate,
        taxable: formatAmount(group.taxable),
        tax: formatAmount(group.tax),
      })),
  }
}

const cbc = (
  name: string,
  value: string | number | null | undefined,
  attributes?: Record<string, string | null | undefined>
) =>
  textElement(`cbc:${name}`, value, attributes)
const cac = (name: string, ...children: Parameters<typeof element>[2][]) =>
  element(`cac:${name}`, null, ...children)

function vatScheme() {
  return cac("TaxScheme", cbc("ID", "VAT"))
}

function partyElement(party: EinvoiceParty): XmlElement {
  return cac(
    "Party",
    party.electronicAddress
      ? cbc("EndpointID", party.electronicAddress.id, { schemeID: party.electronicAddress.scheme })
      : null,
    cac("PartyName", cbc("Name", party.name)),
    cac(
      "PostalAddress",
      cbc("StreetName", party.street),
      cbc("AdditionalStreetName", party.additionalStreet),
      cbc("CityName", party.city),
      cbc("PostalZone", party.postalZone),
      cbc("CountrySubentity", party.region),
      cac("Country", cbc("IdentificationCode", party.countryCode))
    ),
    party.vatId ? cac("PartyTaxScheme", cbc("CompanyID", party.vatId), vatScheme()) : null,
    cac(
      "PartyLegalEntity",
      cbc("RegistrationName", party.name),
      cbc("CompanyID", party.legalId?.id, { schemeID: party.legalId?.scheme })
    ),
    party.email ? cac("Contact", cbc("ElectronicMail", party.email)) : null
  )
}

function paymentMeansElement(payment: EinvoicePayment): XmlElement {
  return cac(
    "PaymentMeans",
    cbc("PaymentMeansCode", payment.meansCode),
    cbc("PaymentID", payment.reference),
    cac(
      "PayeeFinancialAccount",
      cbc("ID", payment.accountId),
      payment.accountName ? cbc("Name", payment.accountName) : null,
      payment.branchId ? cac("FinancialInstitutionBranch", cbc("ID", payment.branchId)) : null
    )
  )
}

function classifiedTaxCategory(line: EinvoiceLine, document: EinvoiceDocument) {
  if (document.calculationVersion === "v2") {
    const group = document.frozenGroups?.find((group) => group.key === line.groupKey)
    if (!group) throw new EinvoiceVatError("frozen_groups_missing", "The document lacks frozen VAT groups")
    return cac("ClassifiedTaxCategory", cbc("ID", frozenCategory(group)),
      group.treatment === "out_of_scope" ? null : cbc("Percent", formatPlainNumber(toDecimal(group.rate).times(100))), vatScheme())
  }
  const category = taxCategoryCode(line)
  return cac(
    "ClassifiedTaxCategory",
    cbc("ID", category),
    cbc("Percent", category === "S" ? formatPlainNumber(line.taxRate) : "0"),
    vatScheme()
  )
}

/**
 * Unit price for a line. The stored net unit price is used unless rounding it would break
 * quantity x price = line net (PEPPOL-EN16931-R120), e.g. for prices entered including tax.
 */
export function linePrice(line: Pick<EinvoiceLine, "quantity" | "unitPriceNet" | "lineNet">): string {
  const quantity = toDecimal(line.quantity)
  const stored = toDecimal(line.unitPriceNet)
  const lineNet = formatAmount(line.lineNet)
  if (quantity.isZero() || formatAmount(quantity.times(stored)) === lineNet) {
    return formatPlainNumber(stored.toDecimalPlaces(4))
  }
  return formatPlainNumber(toDecimal(lineNet).dividedBy(quantity).toDecimalPlaces(6))
}

/** Builds the UBL 2.1 XML. Call `validateEinvoice` first; this assumes the data is complete. */
export function buildUblDocument(document: EinvoiceDocument): string {
  const isInvoice = document.kind === "invoice"
  const currencyID = document.currency
  const money = (name: string, value: string) => cbc(name, value, { currencyID })
  const totals = computeEinvoiceTotals(document)

  const lines = document.lines.map((line, index) =>
    cac(
      isInvoice ? "InvoiceLine" : "CreditNoteLine",
      cbc("ID", String(index + 1)),
      cbc(isInvoice ? "InvoicedQuantity" : "CreditedQuantity", formatPlainNumber(line.quantity), {
        unitCode: "C62",
      }),
      money("LineExtensionAmount", formatAmount(line.lineNet)),
      cac("Item", cbc("Name", line.description.trim() || "-"), classifiedTaxCategory(line, document)),
      cac("Price", money("PriceAmount", linePrice(line)))
    )
  )

  const root = element(
    isInvoice ? "Invoice" : "CreditNote",
    {
      xmlns: isInvoice ? NAMESPACES.invoice : NAMESPACES.creditNote,
      "xmlns:cac": NAMESPACES.cac,
      "xmlns:cbc": NAMESPACES.cbc,
    },
    cbc("CustomizationID", PEPPOL_BIS_CUSTOMIZATION_ID),
    cbc("ProfileID", PEPPOL_BIS_PROFILE_ID),
    cbc("ID", document.number),
    cbc("IssueDate", document.issueDate),
    isInvoice ? cbc("DueDate", document.dueDate) : null,
    cbc(isInvoice ? "InvoiceTypeCode" : "CreditNoteTypeCode", isInvoice ? "380" : "381"),
    cbc("Note", document.note),
    cbc("DocumentCurrencyCode", currencyID),
    cbc("BuyerReference", document.buyerReference),
    document.orderReference ? cac("OrderReference", cbc("ID", document.orderReference)) : null,
    document.billingReference
      ? cac(
          "BillingReference",
          cac(
            "InvoiceDocumentReference",
            cbc("ID", document.billingReference.number),
            cbc("IssueDate", document.billingReference.issueDate)
          )
        )
      : null,
    cac("AccountingSupplierParty", partyElement(document.seller)),
    cac("AccountingCustomerParty", partyElement(document.buyer)),
    isInvoice && document.deliveryDate
      ? cac("Delivery", cbc("ActualDeliveryDate", document.deliveryDate))
      : null,
    isInvoice && document.payment ? paymentMeansElement(document.payment) : null,
    cac(
      "TaxTotal",
      money("TaxAmount", totals.tax),
      totals.groups.map((group) =>
        cac(
          "TaxSubtotal",
          money("TaxableAmount", group.taxable),
          money("TaxAmount", group.tax),
          cac(
            "TaxCategory",
            cbc("ID", group.category),
            cbc("Percent", group.rate),
            group.reason ? cbc("TaxExemptionReason", group.reason) :
              group.category === "E" ? cbc("TaxExemptionReason", "Exempt from VAT") : null,
            vatScheme()
          )
        )
      )
    ),
    cac(
      "LegalMonetaryTotal",
      money("LineExtensionAmount", totals.lineExtension),
      money("TaxExclusiveAmount", totals.taxExclusive),
      money("TaxInclusiveAmount", totals.taxInclusive),
      totals.prepaid !== "0.00" ? money("PrepaidAmount", totals.prepaid) : null,
      totals.rounding !== "0.00" ? money("PayableRoundingAmount", totals.rounding) : null,
      money("PayableAmount", totals.payable)
    ),
    lines
  )

  return serializeXmlDocument(root)
}

type UblTaxCategory = "S" | "K" | "AE" | "G" | "E" | "O" | "Z"
export class EinvoiceVatError extends Error {
  constructor(readonly code: "unclassified_zero" | "out_of_scope_mixed" | "frozen_groups_missing", message: string) {
    super(message)
    this.name = "EinvoiceVatError"
  }
}

function requireClassifiedVat(document: EinvoiceDocument) {
  if (document.lines.some((line) => line.vatTreatment === "unclassified_zero" || line.taxCategory === "unclassified_zero") ||
      document.frozenGroups?.some((group) => group.treatment === "unclassified_zero"))
    throw new EinvoiceVatError("unclassified_zero", "This document contains unclassified zero VAT and cannot be exported as UBL.")
}

function frozenCategory(group: FrozenVatGroup): UblTaxCategory {
  switch (group.treatment) {
    case "standard": return "S"
    case "intra_community": return group.reasonCode === "goods" ? "K" : "AE"
    case "export": return "G"
    case "exempt": return "E"
    case "reverse_charge_domestic": return "AE"
    case "out_of_scope": return "O"
    case "zero_rated": return "Z"
    case "unclassified_zero": throw new EinvoiceVatError("unclassified_zero", "Unclassified zero VAT cannot be exported")
  }
}

const reasonText: Record<string, string> = {
  goods: "Intra-community supply of goods", services_b2b: "Reverse charge for intra-community services",
  goods_outside_eu: "Export of goods outside the EU", financial: "Exempt financial services",
  health: "Exempt health services", education: "Exempt education", other: "VAT exemption",
  construction: "Reverse charge for construction services",
}
function exemptionReason(group: FrozenVatGroup) {
  const category = frozenCategory(group)
  if (["S", "Z"].includes(category)) return undefined
  const reason = group.reasonCode ? reasonText[group.reasonCode] : "Outside the scope of VAT"
  const statement = group.evidence?.statementText
  return [reason, category === "AE" ? "Reverse charge" : null, statement].filter(Boolean).join(". ")
}

/** Frozen v2 taxes and payable rounding are authoritative, including on credit notes. */
function frozenEinvoiceTotals(document: EinvoiceDocument): EinvoiceTotals {
  const groups = document.frozenGroups
  if (!groups?.length) throw new EinvoiceVatError("frozen_groups_missing", "The document lacks frozen VAT groups")
  if (groups.some((group) => group.treatment === "out_of_scope") && groups.some((group) => group.treatment !== "out_of_scope"))
    throw new EinvoiceVatError("out_of_scope_mixed", "Outside-scope VAT cannot mix with other VAT treatments (BR-O-11)")
  const sum = (pick: (group: FrozenVatGroup) => string) => groups.reduce((sum, group) => sum.plus(pick(group)), toDecimal(0))
  const net = sum((g) => g.net), tax = sum((g) => g.tax), rounding = sum((g) => g.payableRounding)
  const prepaid = toDecimal(document.amountPaid)
  return {
    lineExtension: formatAmount(net), taxExclusive: formatAmount(net), tax: formatAmount(tax),
    taxInclusive: formatAmount(net.plus(tax)), prepaid: formatAmount(prepaid), rounding: formatAmount(rounding),
    payable: formatAmount(net.plus(tax).plus(rounding).minus(prepaid)),
    groups: groups.map((group) => ({ category: frozenCategory(group),
      rate: group.treatment === "out_of_scope" ? null : formatPlainNumber(toDecimal(group.rate).times(100)),
      taxable: formatAmount(group.net), tax: formatAmount(group.tax), reason: exemptionReason(group),
    })),
  }
}
