import { deviationVatLabel } from "./documents/line-amounts"
import { formatTaxIds, distinctCompany } from "./documents/tax-ids"
import { pdfBuyerAddress, sellerPresentationTaxIds } from "./documents/invoice-identity"
import { withoutNonVatStatement } from "./documents/non-vat-presentation"
import { nonVatStatement } from "./documents/non-vat-note"
import { sellerVatLineText, sellerVatPresentationStatus } from "./documents/seller-vat"
import type { DocumentTaxId } from "@quits/contracts/documents"
import {
  Document,
  Page,
  Text,
  View,
  Image,
  StyleSheet,
} from "@react-pdf/renderer"
import type { BankAccountSnapshot } from "@quits/contracts/payment-details"
import { formatCurrency, formatDate, formatNumber } from "./i18n/format"
import { translate } from "./i18n/translate"
import { canRenderLogo } from "./documents/logo"
import { buildPaymentDetailsBlock } from "./payment-details-block"
import { lineColumnKeys, priceBasis, type VatRow } from "./documents/line-amounts"
import { buildTotals } from "./documents/totals"
import { documentColors as C } from "./brand/document-colors"

const styles = StyleSheet.create({
  page: {
    padding: 40,
    paddingBottom: 70,
    fontSize: 10,
    fontFamily: "Helvetica",
    color: C.ink,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 30,
  },
  title: {
    fontSize: 24,
    fontFamily: "Helvetica-Bold",
  },
  logoContainer: {
    width: 140,
    height: 56,
    marginBottom: 8,
  },
  logo: {
    width: "100%",
    height: "100%",
    objectFit: "contain",
  },
  sellerMark: {
    fontSize: 16,
    fontFamily: "Helvetica-Bold",
    marginBottom: 8,
  },
  parties: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 20,
  },
  seller: {
    flex: 1,
    paddingRight: 24,
  },
  buyer: {
    width: 270,
  },
  footer: {
    position: "absolute",
    bottom: 20,
    left: 40,
    fontSize: 9,
    color: C.muted,
  },
  headerRight: {
    textAlign: "right",
  },
  label: {
    color: C.muted,
    fontSize: 9,
    marginBottom: 2,
  },
  sectionTitle: {
    fontSize: 9,
    color: C.muted,
    marginBottom: 4,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  contactName: {
    fontSize: 12,
    fontFamily: "Helvetica-Bold",
    marginBottom: 2,
  },
  contactLine: {
    fontSize: 10,
    color: C.body,
    marginBottom: 1,
  },
  tableHeader: {
    flexDirection: "row",
    backgroundColor: C.fill,
    borderBottomWidth: 1,
    borderBottomColor: C.hairline,
    paddingVertical: 6,
    paddingHorizontal: 8,
  },
  tableRow: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: C.fill,
    paddingVertical: 6,
    paddingHorizontal: 8,
  },
  colDescription: { flex: 1 },
  colQty: { width: 60, textAlign: "right" },
  colPrice: { width: 110, textAlign: "right" },
  colTotal: { width: 110, textAlign: "right" },
  headerText: {
    fontFamily: "Helvetica-Bold",
    fontSize: 9,
    color: C.muted,
  },
  totalsContainer: {
    alignItems: "flex-end",
    marginTop: 16,
  },
  totalsRow: {
    flexDirection: "row",
    width: 270,
    justifyContent: "space-between",
    paddingVertical: 3,
  },
  totalsFinal: {
    flexDirection: "row",
    width: 270,
    justifyContent: "space-between",
    paddingVertical: 6,
    borderTopWidth: 1,
    borderTopColor: C.rule,
    marginTop: 4,
  },
  totalLabel: {
    color: C.muted,
  },
  totalValue: {
    fontFamily: "Helvetica-Bold",
  },
  totalFinalLabel: {
    fontFamily: "Helvetica-Bold",
    fontSize: 12,
  },
  totalFinalValue: {
    fontFamily: "Helvetica-Bold",
    fontSize: 12,
  },
  notes: {
    marginTop: 24,
    padding: 12,
    backgroundColor: C.paper,
    borderRadius: 4,
  },
  notesText: {
    fontSize: 9,
    color: C.body,
    lineHeight: 1.5,
  },
  paymentBox: {
    marginTop: 24,
    padding: 12,
    backgroundColor: C.paper,
    borderRadius: 4,
  },
  paymentRow: {
    flexDirection: "row",
    alignItems: "baseline",
    marginBottom: 3,
  },
  paymentLabel: {
    width: 90,
    color: C.muted,
    fontSize: 9,
  },
  paymentValue: {
    flex: 1,
    fontSize: 10,
  },
  paymentNote: {
    marginTop: 4,
    fontSize: 9,
    color: C.body,
    lineHeight: 1.5,
  },
  paymentReference: {
    marginTop: 6,
    paddingTop: 6,
    borderTopWidth: 1,
    borderTopColor: C.hairline,
    fontSize: 10,
  },
  paymentReferenceValue: {
    fontFamily: "Helvetica-Bold",
  },
})

export type OrgSettingsForPdf = {
  taxIds?: DocumentTaxId[]
  /** Frozen for future non-VAT invoices. Historical render inputs keep their original CVR label. */
  cvrLabel?: string
  companyName?: string | null
  companyEmail?: string | null
  companyPhone?: string | null
  companyAddress?: string | null
  companyLogo?: string | null
  locale?: string | null
  timezone?: string | null
}

export type InvoiceForPdf = {
  number: string
  status: string
  issueDate: string
  dueDate: string
  subtotal: number
  taxAmount: number
  total: number
  currency: string
  notes: string | null
  /**
   * Which side of the VAT the item prices are on: the item unit prices and totals below are net
   * when false and gross when true. Absent on inputs frozen before documents stated their basis,
   * whose items are gross; those keep their plain column headers.
   */
  pricesIncludeTax?: boolean
  taxRegime?: string
  momsRegistered?: boolean | null
  /** The date of supply, as `YYYY-MM-DD`. Absent when the invoice has none. */
  supplyDate?: string | null
  /** VAT by rate. Absent on inputs frozen before they carried it; the VAT row is then the single `taxAmount`. */
  taxRate?: number
  vatRows?: VatRow[]
  /** The stored total minus the stored subtotal and tax, as a decimal string; printed when non-zero. */
  rounding?: string
  /**
   * Where to pay. An issued invoice carries the account and note frozen when it was issued; a
   * draft preview carries the organization's current ones. Documents issued earlier have none.
   */
  bankAccount?: BankAccountSnapshot | null
  paymentNote?: string | null
  /**
   * What the payer writes on the transfer: the invoice's own reference, else its number. Null
   * leaves the row out (a draft has no number yet); absent means the invoice number.
   */
  paymentReference?: string | null
  contact: {
    name: string
    taxIds?: DocumentTaxId[]
    email?: string | null
    company?: string | null
    address?: string | null
    city?: string | null
    state?: string | null
    zip?: string | null
    country?: string | null
  }
  /** Unit price and total are the stored amounts on the document's price basis; never derive one from the other. */
  items: Array<{
    description: string
    vatTreatment?: string
    taxRate?: number
    quantity: number
    unitPrice: number
    total: number
  }>
}

export function InvoicePdfDocument({
  invoice,
  org = {},
}: {
  invoice: InvoiceForPdf
  org?: OrgSettingsForPdf
}) {
  const momsRegistered = sellerVatPresentationStatus(invoice.momsRegistered, invoice.taxRegime)
  const notes = withoutNonVatStatement(invoice.notes, momsRegistered, invoice.taxRegime)
  const contact = invoice.contact
  const fromName = org.companyName ?? ""
  const locale = org.locale
  const timezone = org.timezone
  const logo = canRenderLogo(org.companyLogo) ? org.companyLogo : null
  const columns = lineColumnKeys(invoice.pricesIncludeTax === undefined ? undefined : priceBasis(invoice.pricesIncludeTax))
  const totals = buildTotals({
    basis: invoice.pricesIncludeTax === undefined ? undefined : priceBasis(invoice.pricesIncludeTax),
    subtotal: invoice.subtotal, taxAmount: invoice.taxAmount, total: invoice.total,
    vatRows: invoice.vatRows, rounding: invoice.rounding, currency: invoice.currency, locale,
  })
  const paymentDetails = buildPaymentDetailsBlock(
    { bankAccount: invoice.bankAccount, note: withoutNonVatStatement(invoice.paymentNote, momsRegistered, invoice.taxRegime) },
    invoice.paymentReference === undefined ? invoice.number : invoice.paymentReference,
    locale
  )

  return (
    <Document creationDate={new Date(invoice.issueDate)} modificationDate={new Date(invoice.issueDate)}>
      <Page size="A4" style={styles.page}>
        {/* Header */}
        <View style={styles.header}>
          <View style={{ flex: 1, paddingRight: 16 }}>
            {fromName && <Text style={styles.sellerMark}>{fromName}</Text>}
            {logo && (
              <View style={styles.logoContainer}>
                <Image src={logo} style={styles.logo} />
              </View>
            )}
            <Text style={styles.title}>
              {translate("pdf.invoice", locale)} {invoice.number}
            </Text>
          </View>
          <View style={styles.headerRight}>
            <Text style={styles.label}>{translate("pdf.issueDate", locale)}</Text>
            <Text>{formatDate(invoice.issueDate, locale, timezone, { month: "short" })}</Text>
            <Text style={[styles.label, { marginTop: 6 }]}>
              {translate("pdf.dueDate", locale)}
            </Text>
            <Text>{formatDate(invoice.dueDate, locale, "UTC", { month: "short" })}</Text>
            {invoice.supplyDate && (
              <>
                <Text style={[styles.label, { marginTop: 6 }]}>
                  {translate("pdf.supplyDate", locale)}
                </Text>
                {/* A calendar date, not an instant: formatting it in the organization's zone could move it a day. */}
                <Text>{formatDate(invoice.supplyDate, locale, "UTC", { month: "short" })}</Text>
              </>
            )}
          </View>
        </View>

        <View style={styles.parties} wrap={false}>
          {/* From */}
          <View style={styles.seller}>
            <Text style={styles.sectionTitle}>{translate("pdf.from", locale)}</Text>
            <Text style={styles.contactName}>{fromName}</Text>
            {org.companyEmail && <Text style={styles.contactLine}>{org.companyEmail}</Text>}
            {org.companyPhone && <Text style={styles.contactLine}>{org.companyPhone}</Text>}
            {org.companyAddress && <Text style={styles.contactLine}>{org.companyAddress}</Text>}
            {formatTaxIds(sellerPresentationTaxIds(org.taxIds, momsRegistered), locale, contact.country ?? "DK", momsRegistered, org.cvrLabel).map(id => <Text key={id} style={styles.contactLine}>{id}</Text>)}
          </View>

          {/* Bill To */}
          <View style={styles.buyer}>
            <Text style={styles.sectionTitle}>{translate("pdf.billTo", locale)}</Text>
            <Text style={styles.contactName}>{contact.name}</Text>
            {distinctCompany(contact) && <Text style={styles.contactLine}>{distinctCompany(contact)}</Text>}
            {formatTaxIds(contact.taxIds, locale).map(id => <Text key={id} style={styles.contactLine}>{id}</Text>)}
            {contact.email && <Text style={styles.contactLine}>{contact.email}</Text>}
            {pdfBuyerAddress(contact, locale).map((line, index) => <Text key={index} style={styles.contactLine}>{line}</Text>)}
          </View>
        </View>

        {/* Items Table */}
        <View>
          <View style={styles.tableHeader}>
            <Text style={[styles.headerText, styles.colDescription]}>
              {translate("pdf.description", locale)}
            </Text>
            <Text style={[styles.headerText, styles.colQty]}>{translate("pdf.qty", locale)}</Text>
            <Text style={[styles.headerText, styles.colPrice]}>
              {translate(columns.unitPrice, locale)}
            </Text>
            <Text style={[styles.headerText, styles.colTotal]}>
              {translate(columns.amount, locale)}
            </Text>
          </View>
          {invoice.items.map((item, i) => (
            <View key={i} style={styles.tableRow}>
              <View style={styles.colDescription}>
                <Text>{item.description}</Text>{deviationVatLabel(item.taxRate, invoice.vatRows, invoice.taxRate, momsRegistered) && <Text style={[styles.label, { backgroundColor: "#f4f4f4", padding: 3 }]}>{translate("pdf.lineVatRate", locale, { rate: formatNumber(Number(item.taxRate), locale) })}</Text>}
                {!deviationVatLabel(item.taxRate, invoice.vatRows, invoice.taxRate, momsRegistered) && sellerVatLineText(momsRegistered, item.taxRate, locale) && <Text style={styles.label}>{sellerVatLineText(momsRegistered, item.taxRate, locale)}</Text>}
              </View>
              <Text style={styles.colQty}>{item.quantity}</Text>
              <Text style={styles.colPrice}>
                {formatCurrency(item.unitPrice, invoice.currency, locale)}
              </Text>
              <Text style={styles.colTotal}>
                {formatCurrency(item.total, invoice.currency, locale)}
              </Text>
            </View>
          ))}
        </View>

        {/* Totals */}
        <View style={styles.totalsContainer}>
          {totals.lines.map((row, index) => (
            <View key={index} style={styles.totalsRow}>
              <Text style={styles.totalLabel}>{row.label}{row.reason ? `\n${row.reason}` : ""}</Text>
              <Text>{formatCurrency(Number(row.amount), invoice.currency, locale)}</Text>
            </View>
          ))}
          <View style={styles.totalsFinal}>
            <Text style={styles.totalFinalLabel}>{totals.total.label}</Text>
            <Text style={styles.totalFinalValue}>
              {formatCurrency(Number(totals.total.amount), invoice.currency, locale)}
            </Text>
          </View>
        </View>

        {totals.note && <Text style={[styles.label, { borderWidth: 1, padding: 8 }]}>{totals.note}</Text>}
        {/* Payment details */}
        {momsRegistered === false && <Text style={[styles.notesText, { marginTop: 24 }]}>{nonVatStatement(locale)}</Text>}

        {paymentDetails && (
          <View style={styles.paymentBox} wrap={false}>
            <Text style={styles.sectionTitle}>{paymentDetails.title}</Text>
            {paymentDetails.rows.map((row) => (
              <View key={row.label} style={styles.paymentRow}>
                <Text style={styles.paymentLabel}>{row.label}</Text>
                <Text style={styles.paymentValue}>{row.value}</Text>
              </View>
            ))}
            {paymentDetails.note && <Text style={styles.paymentNote}>{paymentDetails.note}</Text>}
            {paymentDetails.reference && (
              <Text style={styles.paymentReference}>
                {paymentDetails.reference.label}:{" "}
                <Text style={styles.paymentReferenceValue}>{paymentDetails.reference.value}</Text>
              </Text>
            )}
          </View>
        )}

        {/* Notes */}
        {notes && (
          <View style={styles.notes}>
            <Text style={styles.sectionTitle}>{translate("pdf.notes", locale)}</Text>
            <Text style={styles.notesText}>{notes}</Text>
          </View>
        )}
        <View style={[styles.footer, { right: 40, flexDirection: "row", justifyContent: "space-between" }]} fixed>
          <Text style={{ flex: 1, paddingRight: 12 }}>{[fromName, org.companyAddress, ...formatTaxIds(sellerPresentationTaxIds(org.taxIds, momsRegistered), locale, contact.country ?? "DK", momsRegistered, org.cvrLabel), org.companyEmail].filter(Boolean).join(" · ")}</Text>
          <Text render={({ pageNumber, totalPages }) => translate("pdf.pageNumber", locale, { page: pageNumber, total: totalPages })} />
        </View>
      </Page>
    </Document>
  )
}

/**
 * Generate a PDF blob for a given invoice. Call this client-side
 * and trigger a download using a temporary anchor element.
 */
