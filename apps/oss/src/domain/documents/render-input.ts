import { createHash } from "node:crypto"
import { Effect } from "effect"
import type { InvoicePdfDocument, OrgSettingsForPdf } from "../../lib/invoice-pdf"
import type { CreditNoteForPdf } from "../../lib/credit-note-pdf"
import type { AgreementPdfInput } from "../../lib/agreement-pdf"
import { buildOfferSnapshot, canonicalizeOffer, hashOfferSnapshot } from "../agreements/snapshot"
import { creditNoteIssueInputSchema } from "@quits/contracts/credit-notes"
import { buildBuyerSnapshot, buildSellerSnapshot } from "./snapshots"
import { loadDocumentContext } from "./context"
import { priceCreditNote } from "./credit-pricing"
import { NotFound } from "../errors"
import { Command, Db } from "../services"

type InvoiceForPdf = import("react").ComponentProps<typeof InvoicePdfDocument>["invoice"]

export type ArtifactDocumentKind = "invoice" | "creditNote" | "agreement"
type RenderIdentity = {
  kind: ArtifactDocumentKind
  organizationId: string
  documentId: string
  number: string
  issuedAt: string
  recipient: string | null
  snapshot: unknown
  commandInputHash?: string
  selectionFingerprint?: string
}
export type RenderInput = RenderIdentity & (
  | { kind: "invoice"; pdf: { invoice: InvoiceForPdf; org: OrgSettingsForPdf } }
  | { kind: "creditNote"; pdf: { creditNote: CreditNoteForPdf; org: OrgSettingsForPdf } }
  | { kind: "agreement"; pdf: AgreementPdfInput }
)
export function hashRenderInput(input: RenderInput) {
  return createHash("sha256").update(canonicalizeOffer(JSON.parse(JSON.stringify(input)))).digest("hex")
}
export function hashBytes(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex")
}
const num = (value: { toNumber(): number }) => value.toNumber()

/** The same prospective input is read at reservation and again under the commit locks. */
export const prospectiveRenderInput = (input: {
  kind: ArtifactDocumentKind
  commandInput: unknown
  documentId: string
  number: string
  issuedAt: Date
  method?: "email" | "manual"
}) => Effect.gen(function* () {
  const db = yield* Db
  const { organizationId } = yield* Command
  const { settings, sellerTaxIds } = yield* loadDocumentContext
  const org: OrgSettingsForPdf = {
    companyName: settings.companyName, companyEmail: settings.companyEmail,
    companyPhone: settings.companyPhone, companyAddress: settings.companyAddress,
    companyLogo: settings.companyLogo, locale: settings.locale, timezone: settings.timezone,
  }
  const base = { kind: input.kind, organizationId, documentId: input.documentId,
    number: input.number, issuedAt: input.issuedAt.toISOString(),
    commandInputHash: createHash("sha256").update(canonicalizeOffer({ input: input.commandInput, method: input.method ?? "email" })).digest("hex") }
  if (input.kind === "invoice") {
    const invoice = yield* Effect.promise(() => db.invoice.findFirst({
      where: { id: input.documentId, organizationId },
      include: { contact: true, items: { orderBy: { sortOrder: "asc" } } },
    }))
    if (!invoice) return yield* new NotFound({ message: "Invoice not found", entity: "invoice", id: input.documentId })
    // All PDF fields, including branding and the intended customer, are frozen here.
    const pdfInvoice: InvoiceForPdf = {
      number: input.number, status: "sent", issueDate: base.issuedAt, dueDate: invoice.dueDate.toISOString(),
      subtotal: num(invoice.subtotalNet), taxAmount: num(invoice.totalTax), total: num(invoice.totalGross),
      currency: invoice.currency, notes: invoice.notes, contact: { ...buildBuyerSnapshot(invoice.contact), name: invoice.contact.name },
      items: invoice.items.map(line => ({ description: line.description, quantity: num(line.quantity),
        unitPrice: num(line.unitPriceGross), total: num(line.lineGross) })),
    }
    return { ...base, kind: "invoice" as const, recipient: invoice.contact.email?.trim() || null,
      snapshot: { seller: buildSellerSnapshot(settings, sellerTaxIds), buyer: pdfInvoice.contact,
        invoice: pdfInvoice, items: invoice.items, supplyDate: invoice.supplyDate,
        pricesIncludeTax: invoice.pricesIncludeTax, countryCode: invoice.countryCode,
        taxRegime: invoice.taxRegime, paymentReference: invoice.paymentReference,
        purchaseOrderRef: invoice.purchaseOrderRef },
      pdf: { invoice: pdfInvoice, org: { ...org, locale: invoice.locale, timezone: invoice.timezone } } }
  }
  if (input.kind === "creditNote") {
    const selection = creditNoteIssueInputSchema.parse(input.commandInput)
    const invoice = yield* Effect.promise(() => db.invoice.findFirst({
      where: { id: selection.invoiceId, organizationId },
      include: { contact: true, items: { orderBy: { sortOrder: "asc" } },
        creditNotes: { where: { status: "issued" }, include: { items: true } } },
    }))
    if (!invoice) return yield* new NotFound({ message: "Invoice not found", entity: "invoice", id: selection.invoiceId })
    const built = yield* priceCreditNote(invoice, selection)
    const sellerSnapshot = invoice.sellerSnapshot ?? buildSellerSnapshot(settings, sellerTaxIds)
    const buyerSnapshot = invoice.buyerSnapshot ?? buildBuyerSnapshot(invoice.contact)
    const creditNote: CreditNoteForPdf = {
      number: input.number, issueDate: base.issuedAt, reason: selection.reason,
      subtotal: built.subtotalNet, taxAmount: built.totalTax, total: built.totalGross,
      currency: invoice.currency, locale: invoice.locale, timezone: invoice.timezone,
      sellerSnapshot, buyerSnapshot, contact: { ...buildBuyerSnapshot(invoice.contact), name: invoice.contact.name },
      invoice: { number: invoice.number, issueDate: invoice.issueDate.toISOString() },
      items: built.lines.map(line => ({ description: line.description, quantity: line.quantity,
        unitPrice: line.unitPriceGross, total: line.lineGross })),
    }
    return { ...base, kind: "creditNote" as const, recipient: null,
      selectionFingerprint: createHash("sha256").update(canonicalizeOffer(selection)).digest("hex"),
      snapshot: { sellerSnapshot, buyerSnapshot, built, invoiceId: invoice.id,
        currency: invoice.currency, countryCode: invoice.countryCode, locale: invoice.locale,
        timezone: invoice.timezone, taxRegime: invoice.taxRegime, pricesIncludeTax: invoice.pricesIncludeTax },
      pdf: { creditNote, org } }
  }
  const agreement = yield* Effect.promise(() => db.agreement.findFirst({
    where: { id: input.documentId, organizationId }, include: { contact: true, deliverables: { orderBy: { sortOrder: "asc" } } },
  }))
  if (!agreement) return yield* new NotFound({ message: "Agreement not found", entity: "agreement", id: input.documentId })
  const commandInput = input.commandInput as { recipient?: string }
  const recipient = input.method === "manual" ? commandInput.recipient ?? null : agreement.contact.email?.trim() || null
  const snapshot = buildOfferSnapshot({ ...agreement,
    sellerSnapshot: buildSellerSnapshot(settings, sellerTaxIds), buyerSnapshot: buildBuyerSnapshot(agreement.contact) })
  // The offer's issuance date remains unchanged on an unchanged retry, just as before A3a.
  const issuedAt = agreement.offerSnapshotHash === hashOfferSnapshot(snapshot) && agreement.issuedToEmail === recipient
    ? agreement.issueDate?.toISOString() ?? base.issuedAt : base.issuedAt
  return { ...base, kind: "agreement" as const, issuedAt, recipient, snapshot,
    pdf: { snapshot, number: input.number, issueDate: issuedAt } }
})
