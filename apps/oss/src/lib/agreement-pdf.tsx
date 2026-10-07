import { Document, Page, Text, View, StyleSheet, renderToBuffer } from "@react-pdf/renderer"
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
  return (
    <Document title={snapshot.title}>
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
        {snapshot.deliverables.map((line, i) => (
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
            Subtotal: {snapshot.subtotalNet} {snapshot.currency}
          </Text>
          <Text>
            Tax: {snapshot.totalTax} {snapshot.currency}
          </Text>
          <Text>
            Total: {snapshot.totalGross} {snapshot.currency}
          </Text>
          <Text>Payment due in {snapshot.dueInDays} days</Text>
          <Text>
            Billing:{" "}
            {snapshot.billingTrigger === "on_acceptance" ? "After acceptance" : "After delivery"}
          </Text>
        </View>
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
export async function agreementPdfResponse(input: AgreementPdfInput) {
  const buffer = await renderToBuffer(<AgreementPdf {...input} />)
  return new Response(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": 'inline; filename="agreement.pdf"',
      "Cache-Control": "private, no-store",
    },
  })
}
