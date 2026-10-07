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
})
export type AgreementPdfInput = {
  snapshot: AgreementOfferSnapshot
  number?: string | null
  issueDate?: string | null
  acceptance?: PublicAgreementDto["acceptance"]
}
export function AgreementPdf({ snapshot, number, issueDate, acceptance }: AgreementPdfInput) {
  const v2 = "offerFormatVersion" in snapshot ? snapshot : null
  return (
    <Document title={snapshot.title} creationDate={new Date(issueDate ?? 0)} modificationDate={new Date(issueDate ?? 0)}>
      <Page size="A4" style={styles.page}>
        <Text style={styles.title}>Agreement {number ?? "preview"}</Text>
        <Text style={styles.heading}>{snapshot.title}</Text>
        <View style={styles.section}>
          <Text>{snapshot.sellerSnapshot?.companyName}</Text>
          <Text>{snapshot.sellerSnapshot?.companyAddress}</Text>
          <Text>
            Customer: {snapshot.buyerSnapshot?.name} {snapshot.buyerSnapshot?.company}
          </Text>
          <Text>{snapshot.buyerSnapshot?.email}</Text>
          {issueDate && <Text>Issued: {issueDate.slice(0, 10)}</Text>}
          <Text>
            Valid until: {snapshot.validUntil.slice(0, 10)} ({snapshot.timezone})
          </Text>
          <Text>{snapshot.summary}</Text>
        </View>
        <Text style={styles.heading}>Deliverables</Text>
        {snapshot.deliverables.map((line, i) => v2 && line.isDeposit ? null : (
          <View key={i} style={styles.row} wrap={false}>
            <Text>
              {line.title}
              {line.isDeposit ? " (deposit included in total)" : ""}
            </Text>
            <Text>{line.description}</Text>
            <Text>
              {line.quantity} x {line.unitPriceGross} = {line.lineGross} {snapshot.currency}
            </Text>
            {line.agreedDate && <Text>Agreed date: {line.agreedDate.slice(0, 10)}</Text>}
          </View>
        ))}
        <View style={styles.section}>
          <Text>
            Subtotal: {v2?.serviceTotal.net ?? snapshot.subtotalNet} {snapshot.currency}
          </Text>
          <Text>
            Tax: {v2?.serviceTotal.tax ?? snapshot.totalTax} {snapshot.currency}
          </Text>
          {v2 && Number(v2.serviceTotal.payableRounding) !== 0 && <Text>Payable rounding: {v2.serviceTotal.payableRounding} {snapshot.currency}</Text>}
          <Text>
            {v2 ? "Service total" : "Total"}: {v2?.serviceTotal.gross ?? snapshot.totalGross} {snapshot.currency}
          </Text>
          <Text>Payment due in {snapshot.dueInDays} days</Text>
          <Text>
            Billing:{" "}
            {snapshot.billingTrigger === "on_acceptance" ? "After acceptance" : "After delivery"}
          </Text>
        </View>
        {v2 && <View style={styles.section}>
          <Text style={styles.heading}>Payment schedule</Text>
          {v2.paymentSchedule.map(line => <View key={line.sortOrder} style={styles.row}>
            <Text>{line.title}: {line.amount} {snapshot.currency} ({line.vatBasis === "gross" ? "including VAT" : "excluding VAT"})</Text>
            <Text>On agreement acceptance</Text>
          </View>)}
        </View>}
        <Text style={styles.heading}>Terms</Text>
        <Text style={styles.section}>{agreementTermsText(snapshot.termsHtml)}</Text>
        {acceptance && (
          <View style={styles.section}>
            <Text style={styles.heading}>Acceptance record</Text>
            <Text>Name: {acceptance.name}</Text>
            <Text>Intended recipient: {acceptance.intendedRecipient ?? "Not specified"}</Text>
            <Text>Accepted at: {acceptance.at}</Text>
            <Text>
              Method:{" "}
              {acceptance.method === "customer_link"
                ? "Customer link"
                : "Recorded by the freelancer"}
            </Text>
            <Text>Offer revision: {acceptance.revision}</Text>
            <Text>Offer hash: {acceptance.hash}</Text>
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
  const bytes = await renderer.renderPdf({
    kind: "agreement", organizationId: "preview", documentId: "preview",
    number: input.number ?? "preview", issuedAt: input.issueDate ?? new Date().toISOString(),
    recipient: null, pdf: input, snapshot: input.snapshot,
  })
  return new Response(new Uint8Array(bytes), { headers: {
    "Content-Type": "application/pdf", "Content-Disposition": 'inline; filename="agreement.pdf"',
    "Cache-Control": "private, no-store",
  } })
}
