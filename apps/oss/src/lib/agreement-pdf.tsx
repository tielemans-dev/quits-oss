import { pdfBuyerAddress } from "./documents/invoice-identity"
import { formatTaxIds, distinctCompany } from "./documents/tax-ids"
import { formatCurrency, formatDate, formatDateTime } from "./i18n/format"
import { translate } from "./i18n/translate"
import type { TranslationKey } from "./i18n/messages"
import { agreementOfferTotals } from "./agreements/offer-totals"
import { agreementVatPresentation } from "./agreements/vat-presentation"
import { Document, Page, Text, View, StyleSheet } from "@react-pdf/renderer"
import type { AgreementOfferSnapshot } from "@quits/contracts/agreements"
import sanitizeHtml from "sanitize-html"
import type { PublicAgreementDto } from "./agreements/public"
import { sanitizeAgreementHtml } from "./agreements/markdown"

/** The same restricted HTML used by the page and email, converted to PDF text, never executable HTML. */
export function agreementTermsText(html: string) {
  return sanitizeHtml(
    sanitizeAgreementHtml(html).replace(
      /<\/(?:p|h[1-6]|li|tr|blockquote|pre)>|<br\s*\/?\s*>/g,
      "\n",
    ),
    { allowedTags: [], allowedAttributes: {} },
  )
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
}
const styles = StyleSheet.create({
  page: { padding: 40, fontSize: 10, fontFamily: "Helvetica", lineHeight: 1.4 },
  title: { fontSize: 22, marginBottom: 16 },
  section: { marginBottom: 16 },
  row: { marginBottom: 8 },
  heading: { fontSize: 14, marginBottom: 8 },
  evidence: { marginTop: 8, fontSize: 7, color: "#6b6b6b" },
})
export type AgreementPdfInput = {
  snapshot: AgreementOfferSnapshot
  number?: string | null
  issueDate?: string | null
  acceptance?: PublicAgreementDto["acceptance"]
}
export function AgreementPdf({ snapshot, number, issueDate, acceptance }: AgreementPdfInput) {
  const vat = agreementVatPresentation(snapshot)
  const v2 = "offerFormatVersion" in snapshot ? snapshot : null
  const totals = agreementOfferTotals(snapshot)
  // Labels, money and dates follow the language the offer was written in, as on its page.
  const t = (key: TranslationKey, vars?: Record<string, string | number>) => translate(key, snapshot.locale, vars)
  const money = (amount: string) => formatCurrency(Number(amount), snapshot.currency, snapshot.locale)
  // Validity and agreed dates are calendar dates: shown as stored, not shifted by a timezone.
  const calendarDate = (value: string) => formatDate(value, snapshot.locale, "UTC")
  const terms = agreementTermsText(snapshot.termsHtml).trim()
  return (
    <Document title={snapshot.title} creationDate={new Date(issueDate ?? 0)} modificationDate={new Date(issueDate ?? 0)}>
      <Page size="A4" style={styles.page}>
        <Text style={styles.title}>{t("agreements.document")}{number ? ` ${number}` : ""}</Text>
        <Text style={styles.heading}>{snapshot.title}</Text>
        <View style={styles.section}>
          <Text>{snapshot.sellerSnapshot?.companyName}</Text>
          <Text>{snapshot.sellerSnapshot?.companyAddress}</Text>
          {formatTaxIds(snapshot.sellerSnapshot?.taxIds, snapshot.locale, snapshot.buyerSnapshot?.country ?? "DK", vat.status).map(id => <Text key={id}>{id}</Text>)}
          <Text>
            {t("agreements.customer")}: {snapshot.buyerSnapshot?.name} {distinctCompany(snapshot.buyerSnapshot)}
          </Text>
          {pdfBuyerAddress(snapshot.buyerSnapshot ?? {}, snapshot.locale).map((line, index) => <Text key={index}>{line}</Text>)}
          {formatTaxIds(snapshot.buyerSnapshot?.taxIds, snapshot.locale).map(id => <Text key={id}>{id}</Text>)}
          {snapshot.buyerSnapshot?.email && <Text>{snapshot.buyerSnapshot.email}</Text>}
          {issueDate && <Text>{t("agreements.issued")}: {formatDate(issueDate, snapshot.locale, snapshot.timezone)}</Text>}
          <Text>
            {t("agreements.validUntil")}: {calendarDate(snapshot.validUntil)} ({snapshot.timezone})
          </Text>
          {snapshot.summary && <Text>{snapshot.summary}</Text>}
        </View>
        <Text style={styles.heading}>{t("agreements.deliverables")}</Text>
        {snapshot.deliverables.map((line, i) => v2 && line.isDeposit ? null : (
          <View key={i} style={styles.row} wrap={false}>
            <Text>
              {line.title}
              {line.isDeposit ? ` · ${t("agreements.deposit")}` : ""}
            </Text>
            <Text>{line.description}</Text>
            <Text>
              {line.quantity} × {line.unitPriceGross} = {line.lineGross} {snapshot.currency}
            </Text>
            {vat.lineLabel(line.taxRate) && <Text>{vat.lineLabel(line.taxRate)}</Text>}
            {line.agreedDate && <Text>{t("agreements.agreedDate")}: {calendarDate(line.agreedDate)}</Text>}
          </View>
        ))}
        <View style={styles.section}>
          {vat.totals && vat.status !== false ? <>
            {vat.totals.lines.map((row, i) => <Text key={i}>{row.label}: {money(row.amount)}{row.reason ? ` · ${row.reason}` : ""}</Text>)}
            <Text>{t("agreements.serviceTotal")}: {money(vat.totals.total.amount)}</Text>
            {vat.totals.note && <Text>{vat.totals.note}</Text>}
          </> : <>
          <Text>{t("agreements.subtotal")}: {money(totals.net)}</Text>
          <Text>{vat.taxLabel}: {money(totals.tax)}</Text>
          {totals.payableRounding && <Text>{t("agreements.payableRounding")}: {money(totals.payableRounding)}</Text>}
          <Text>{t(totals.isV2 ? "agreements.serviceTotal" : "agreements.total")}: {money(totals.gross)}</Text>
          </>}
          <Text>{t("agreements.paymentDue", { days: snapshot.dueInDays })}</Text>
          <Text>
            {t("agreements.billingTrigger")}:{" "}
            {t(snapshot.billingTrigger === "on_acceptance" ? "agreements.onAcceptance" : "agreements.onDelivery")}
          </Text>
        </View>
        {v2 && v2.paymentSchedule.length > 0 && <View style={styles.section}>
          <Text style={styles.heading}>{t("agreements.paymentSchedule")}</Text>
          {v2.paymentSchedule.map(line => <View key={line.sortOrder} style={styles.row}>
            <Text>{line.title}: {money(line.amount)} {vat.scheduleBasis(line.vatBasis)}</Text>
            <Text>{t("agreements.scheduleTrigger")}</Text>
          </View>)}
        </View>}
        {vat.statement && <Text style={styles.section}>{vat.statement}</Text>}
        {terms && <>
          <Text style={styles.heading}>{t("agreements.publicTerms")}</Text>
          <Text style={styles.section}>{terms}</Text>
        </>}
        {acceptance && (
          <View style={styles.section}>
            <Text style={styles.heading}>{t("agreements.acceptanceRecord")}</Text>
            <Text>{t("agreements.acceptedBy")}: {acceptance.name}</Text>
            <Text>{t("agreements.recipient")}: {acceptance.intendedRecipient ?? t("agreements.unspecified")}</Text>
            <Text>{t("agreements.acceptedAt")}: {formatDateTime(acceptance.at, snapshot.locale, snapshot.timezone || "Europe/Copenhagen")}</Text>
            <Text>
              {t("agreements.method")}:{" "}
              {t(acceptance.method === "customer_link" ? "agreements.customerLinkMethod" : "agreements.internalMethod")}
            </Text>
            <Text>{t("agreements.revision")}: {acceptance.revision}</Text>
            {/* Evidence of exactly what was accepted, in full but set apart from the reading text. */}
            {acceptance.hash && <Text style={styles.evidence}>{t("agreements.hash")}: {acceptance.hash}</Text>}
          </View>
        )}
      </Page>
    </Document>
  )
}
/** Rendering is supplied by the host; core never imports a server PDF implementation. */
export async function agreementPdfResponse(input: AgreementPdfInput) {
  const { getDocumentRenderer } = await import("./runtime/services")
  const renderer = getDocumentRenderer()
  if (!renderer) return new Response("Document renderer unavailable", { status: 503 })
  const { renderPdf } = await import("./documents/render-pdf")
  const bytes = await renderPdf(renderer, {
    kind: "agreement", organizationId: "preview", documentId: "preview",
    number: input.number ?? "preview", issuedAt: input.issueDate ?? new Date().toISOString(),
    recipient: null, pdf: input, snapshot: input.snapshot,
  })
  return new Response(new Uint8Array(bytes), { headers: {
    "Content-Type": "application/pdf", "Content-Disposition": 'inline; filename="agreement.pdf"',
    "Cache-Control": "private, no-store",
  } })
}
