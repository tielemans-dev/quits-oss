import { Document, Image, Page, StyleSheet, Text, View, pdf } from "@react-pdf/renderer"
import { formatCurrency, formatDate } from "./i18n/format"
import { translate } from "./i18n/translate"
import type { OrgSettingsForPdf } from "./invoice-pdf"

const styles = StyleSheet.create({
  page: { padding: 40, fontSize: 10, fontFamily: "Helvetica", color: "#1a1a1a" },
  header: { flexDirection: "row", justifyContent: "space-between", marginBottom: 30 },
  title: { fontSize: 24, fontFamily: "Helvetica-Bold" },
  logoContainer: { width: 140, height: 56, marginBottom: 8 },
  logo: { width: "100%", height: "100%", objectFit: "contain" },
  headerRight: { textAlign: "right" },
  label: { color: "#6b7280", fontSize: 9, marginBottom: 2 },
  section: { marginBottom: 20 },
  sectionTitle: {
    fontSize: 9,
    color: "#6b7280",
    marginBottom: 4,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  contactName: { fontSize: 12, fontFamily: "Helvetica-Bold", marginBottom: 2 },
  contactLine: { fontSize: 10, color: "#374151", marginBottom: 1 },
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
  colPrice: { width: 80, textAlign: "right" },
  colTotal: { width: 80, textAlign: "right" },
  headerText: { fontFamily: "Helvetica-Bold", fontSize: 9, color: "#6b7280" },
  totalsContainer: { alignItems: "flex-end", marginTop: 16 },
  totalsRow: { flexDirection: "row", width: 200, justifyContent: "space-between", paddingVertical: 3 },
  totalsFinal: {
    flexDirection: "row",
    width: 200,
    justifyContent: "space-between",
    paddingVertical: 6,
    borderTopWidth: 1,
    borderTopColor: "#d1d5db",
    marginTop: 4,
  },
  totalLabel: { color: "#6b7280" },
  totalFinal: { fontFamily: "Helvetica-Bold", fontSize: 12 },
  reason: { marginTop: 24, padding: 12, backgroundColor: "#f9fafb", borderRadius: 4 },
  reasonText: { fontSize: 9, color: "#374151", lineHeight: 1.5 },
})

export type CreditNoteForPdf = {
  number: string
  issueDate: string | Date
  reason: string
  subtotal: number
  taxAmount: number
  total: number
  currency: string
  locale?: string | null
  timezone?: string | null
  invoice: { number: string; issueDate: string | Date }
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
  items: Array<{ description: string; quantity: number; unitPrice: number; total: number }>
}

function canRenderLogo(logo: string | null | undefined) {
  if (!logo) return false
  return logo.startsWith("data:image/") || /^https?:\/\/.+/i.test(logo)
}

export function CreditNotePdfDocument({
  creditNote,
  org = {},
}: {
  creditNote: CreditNoteForPdf
  org?: OrgSettingsForPdf
}) {
  // The credit note keeps the language and time zone of the invoice it credits.
  const locale = creditNote.locale ?? org.locale
  const timezone = creditNote.timezone ?? org.timezone
  const contact = creditNote.contact
  const logo = canRenderLogo(org.companyLogo) ? org.companyLogo : null
  const money = (amount: number) => formatCurrency(amount, creditNote.currency, locale)

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <View style={styles.header}>
          <View>
            {logo && (
              <View style={styles.logoContainer}>
                <Image src={logo} style={styles.logo} />
              </View>
            )}
            <Text style={styles.title}>
              {translate("creditNotes.pdf.title", locale)} {creditNote.number}
            </Text>
          </View>
          <View style={styles.headerRight}>
            <Text style={styles.label}>{translate("pdf.issueDate", locale)}</Text>
            <Text>{formatDate(creditNote.issueDate, locale, timezone)}</Text>
            <Text style={[styles.label, { marginTop: 6 }]}>
              {translate("creditNotes.pdf.reference", locale)}
            </Text>
            <Text>{creditNote.invoice.number}</Text>
            <Text style={[styles.label, { marginTop: 6 }]}>
              {translate("creditNotes.pdf.invoiceDate", locale)}
            </Text>
            <Text>{formatDate(creditNote.invoice.issueDate, locale, timezone)}</Text>
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{translate("pdf.from", locale)}</Text>
          <Text style={styles.contactName}>{org.companyName ?? "YAIP"}</Text>
          {org.companyEmail && <Text style={styles.contactLine}>{org.companyEmail}</Text>}
          {org.companyPhone && <Text style={styles.contactLine}>{org.companyPhone}</Text>}
          {org.companyAddress && <Text style={styles.contactLine}>{org.companyAddress}</Text>}
        </View>

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

        <View>
          <View style={styles.tableHeader}>
            <Text style={[styles.headerText, styles.colDescription]}>
              {translate("pdf.description", locale)}
            </Text>
            <Text style={[styles.headerText, styles.colQty]}>{translate("pdf.qty", locale)}</Text>
            <Text style={[styles.headerText, styles.colPrice]}>{translate("pdf.unitPrice", locale)}</Text>
            <Text style={[styles.headerText, styles.colTotal]}>{translate("pdf.total", locale)}</Text>
          </View>
          {creditNote.items.map((item, index) => (
            <View key={index} style={styles.tableRow}>
              <Text style={styles.colDescription}>{item.description}</Text>
              <Text style={styles.colQty}>{item.quantity}</Text>
              <Text style={styles.colPrice}>{money(item.unitPrice)}</Text>
              <Text style={styles.colTotal}>{money(item.total)}</Text>
            </View>
          ))}
        </View>

        <View style={styles.totalsContainer}>
          <View style={styles.totalsRow}>
            <Text style={styles.totalLabel}>{translate("pdf.subtotal", locale)}</Text>
            <Text>{money(creditNote.subtotal)}</Text>
          </View>
          {creditNote.taxAmount > 0 && (
            <View style={styles.totalsRow}>
              <Text style={styles.totalLabel}>{translate("pdf.tax", locale)}</Text>
              <Text>{money(creditNote.taxAmount)}</Text>
            </View>
          )}
          <View style={styles.totalsFinal}>
            <Text style={styles.totalFinal}>{translate("pdf.total", locale)}</Text>
            <Text style={styles.totalFinal}>{money(creditNote.total)}</Text>
          </View>
        </View>

        <View style={styles.reason}>
          <Text style={styles.sectionTitle}>{translate("creditNotes.pdf.reason", locale)}</Text>
          <Text style={styles.reasonText}>{creditNote.reason}</Text>
        </View>
      </Page>
    </Document>
  )
}

export async function generateCreditNotePdf(
  creditNote: CreditNoteForPdf,
  org: OrgSettingsForPdf = {}
): Promise<Blob> {
  return pdf(<CreditNotePdfDocument creditNote={creditNote} org={org} />).toBlob()
}

/** Triggers a browser download of the credit note PDF. */
export async function downloadCreditNotePdf(
  creditNote: CreditNoteForPdf,
  org: OrgSettingsForPdf = {}
) {
  const blob = await generateCreditNotePdf(creditNote, org)
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = `${creditNote.number}.pdf`
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}
