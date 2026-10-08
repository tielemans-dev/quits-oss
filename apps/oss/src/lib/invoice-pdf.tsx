import {
  Document,
  Page,
  Text,
  View,
  Image,
  StyleSheet,
} from "@react-pdf/renderer"
import type { BankAccountSnapshot } from "@quits/contracts/payment-details"
import { formatCurrency, formatDate } from "./i18n/format"
import { translate } from "./i18n/translate"
import { canRenderLogo } from "./documents/logo"
import type { TranslationKey } from "./i18n/messages"
import { buildPaymentDetailsBlock } from "./payment-details-block"
import { lineColumnKeys, priceBasis, type VatRow } from "./documents/line-amounts"
import { buildTotals } from "./documents/totals"

const styles = StyleSheet.create({
  page: {
    padding: 40,
    fontSize: 10,
    fontFamily: "Helvetica",
    color: "#1a1a1a",
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
  statusBadge: {
    marginTop: 4,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 10,
    fontSize: 9,
    alignSelf: "flex-start",
  },
  headerRight: {
    textAlign: "right",
  },
  label: {
    color: "#6b7280",
    fontSize: 9,
    marginBottom: 2,
  },
  section: {
    marginBottom: 20,
  },
  sectionTitle: {
    fontSize: 9,
    color: "#6b7280",
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
    color: "#374151",
    marginBottom: 1,
  },
  tableHeader: {
    flexDirection: "row",
    backgroundColor: "#f3f4f6",
    borderBottomWidth: 1,
    borderBottomColor: "#e5e7eb",
    paddingVertical: 6,
    paddingHorizontal: 8,
  },
  tableRow: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: "#f3f4f6",
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
    color: "#6b7280",
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
    borderTopColor: "#d1d5db",
    marginTop: 4,
  },
  totalLabel: {
    color: "#6b7280",
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
    backgroundColor: "#f9fafb",
    borderRadius: 4,
  },
  notesText: {
    fontSize: 9,
    color: "#374151",
    lineHeight: 1.5,
  },
  paymentBox: {
    marginTop: 24,
    padding: 12,
    backgroundColor: "#f9fafb",
    borderRadius: 4,
  },
  paymentRow: {
    flexDirection: "row",
    alignItems: "baseline",
    marginBottom: 3,
  },
  paymentLabel: {
    width: 90,
    color: "#6b7280",
    fontSize: 9,
  },
  paymentValue: {
    flex: 1,
    fontSize: 10,
  },
  paymentNote: {
    marginTop: 4,
    fontSize: 9,
    color: "#374151",
    lineHeight: 1.5,
  },
  paymentReference: {
    marginTop: 6,
    paddingTop: 6,
    borderTopWidth: 1,
    borderTopColor: "#e5e7eb",
    fontSize: 10,
  },
  paymentReferenceValue: {
    fontFamily: "Helvetica-Bold",
  },
})

export type OrgSettingsForPdf = {
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
  /** The date of supply, as `YYYY-MM-DD`. Absent when the invoice has none. */
  supplyDate?: string | null
  /** VAT by rate. Absent on inputs frozen before they carried it; the VAT row is then the single `taxAmount`. */
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
    quantity: number
    unitPrice: number
    total: number
  }>
}

function getStatusStyle(status: string) {
  switch (status) {
    case "paid":
      return { backgroundColor: "#dcfce7", color: "#166534" }
    case "sent":
      return { backgroundColor: "#dbeafe", color: "#1e40af" }
    case "overdue":
      return { backgroundColor: "#fee2e2", color: "#991b1b" }
    default:
      return { backgroundColor: "#f3f4f6", color: "#374151" }
  }
}

function statusKey(status: string): TranslationKey {
  switch (status) {
    case "sent":
      return "status.sent"
    case "viewed":
      return "status.viewed"
    case "paid":
      return "status.paid"
    case "overdue":
      return "status.overdue"
    default:
      return "status.draft"
  }
}

export function InvoicePdfDocument({
  invoice,
  org = {},
}: {
  invoice: InvoiceForPdf
  org?: OrgSettingsForPdf
}) {
  const contact = invoice.contact
  const statusStyle = getStatusStyle(invoice.status)
  const fromName = org.companyName ?? "Quits"
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
    { bankAccount: invoice.bankAccount, note: invoice.paymentNote },
    invoice.paymentReference === undefined ? invoice.number : invoice.paymentReference,
    locale
  )

  return (
    <Document creationDate={new Date(invoice.issueDate)} modificationDate={new Date(invoice.issueDate)}>
      <Page size="A4" style={styles.page}>
        {/* Header */}
        <View style={styles.header}>
          <View>
            {logo && (
              <View style={styles.logoContainer}>
                <Image src={logo} style={styles.logo} />
              </View>
            )}
            <Text style={styles.title}>
              {translate("pdf.invoice", locale)} {invoice.number}
            </Text>
            <Text
              style={[
                styles.statusBadge,
                { backgroundColor: statusStyle.backgroundColor, color: statusStyle.color },
              ]}
            >
              {translate(statusKey(invoice.status), locale)}
            </Text>
          </View>
          <View style={styles.headerRight}>
            <Text style={styles.label}>{translate("pdf.issueDate", locale)}</Text>
            <Text>{formatDate(invoice.issueDate, locale, timezone)}</Text>
            <Text style={[styles.label, { marginTop: 6 }]}>
              {translate("pdf.dueDate", locale)}
            </Text>
            <Text>{formatDate(invoice.dueDate, locale, timezone)}</Text>
            {invoice.supplyDate && (
              <>
                <Text style={[styles.label, { marginTop: 6 }]}>
                  {translate("pdf.supplyDate", locale)}
                </Text>
                {/* A calendar date, not an instant: formatting it in the organization's zone could move it a day. */}
                <Text>{formatDate(invoice.supplyDate, locale, "UTC")}</Text>
              </>
            )}
          </View>
        </View>

        {/* From */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{translate("pdf.from", locale)}</Text>
          <Text style={styles.contactName}>{fromName}</Text>
          {org.companyEmail && <Text style={styles.contactLine}>{org.companyEmail}</Text>}
          {org.companyPhone && <Text style={styles.contactLine}>{org.companyPhone}</Text>}
          {org.companyAddress && <Text style={styles.contactLine}>{org.companyAddress}</Text>}
        </View>

        {/* Bill To */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{translate("pdf.billTo", locale)}</Text>
          <Text style={styles.contactName}>{contact.name}</Text>
          {contact.company && <Text style={styles.contactLine}>{contact.company}</Text>}
          {contact.email && <Text style={styles.contactLine}>{contact.email}</Text>}
          {contact.address && <Text style={styles.contactLine}>{contact.address}</Text>}
          {(contact.city || contact.state || contact.zip) && (
            <Text style={styles.contactLine}>
              {[contact.city, contact.state, contact.zip].filter(Boolean).join(", ")}
            </Text>
          )}
          {contact.country && <Text style={styles.contactLine}>{contact.country}</Text>}
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
              <Text style={styles.colDescription}>{item.description}</Text>
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
              <Text style={styles.totalLabel}>{row.label}</Text>
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

        {/* Payment details */}
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
        {invoice.notes && (
          <View style={styles.notes}>
            <Text style={styles.sectionTitle}>{translate("pdf.notes", locale)}</Text>
            <Text style={styles.notesText}>{invoice.notes}</Text>
          </View>
        )}
      </Page>
    </Document>
  )
}

/**
 * Generate a PDF blob for a given invoice. Call this client-side
 * and trigger a download using a temporary anchor element.
 */
