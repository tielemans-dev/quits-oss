import { frozenEinvoiceInput } from "./einvoice-input"
import { frozenVatRows, vatRowsByRate } from "./frozen-vat-groups"
import { lineAmounts, priceBasis } from "../../lib/documents/line-amounts"
import { formatIsoDate } from "../../lib/exports/format"
import { requireVatIssuance } from "./vat-issuance"
import { toDecimal } from "../../lib/exports/format"
import { parseBuyerSnapshot, parseSellerSnapshot } from "@quits/contracts/documents"
import { invoiceMoneySnapshot, creditMoneySnapshot, type InvoiceMoneySnapshot } from "./money-snapshot"
import { lockDocument } from "./locks"
import { createHash } from "node:crypto"
import { Effect } from "effect"
import type { InvoicePdfDocument, OrgSettingsForPdf } from "../../lib/invoice-pdf"
import type { CreditNoteForPdf } from "../../lib/credit-note-pdf"
import type { AgreementPdfInput } from "../../lib/agreement-pdf"
import { buildOfferSnapshot, canonicalizeOffer, hashOfferSnapshot } from "../agreements/snapshot"
import { creditNoteIssueInputSchema } from "@quits/contracts/credit-notes"
import { buildBuyerSnapshot, buildSellerSnapshot, withInvoicePaymentDetails, withoutPaymentDetails } from "./snapshots"
import { loadDocumentContext } from "./context"
import { priceCreditNote } from "./credit-pricing"
import { InvalidState, NotFound } from "../errors"
import { Command, Db } from "../services"
import { issuedNumber } from "./numbering"

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
  ubl?: import("../../lib/exports/ubl").EinvoiceDocument
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
export { hashBytes } from "./hash"
const num = (value: { toNumber(): number }) => value.toNumber()

/** The same prospective input is read at reservation and again under the commit locks. */
export const prospectiveRenderInput = (input: {
  kind: ArtifactDocumentKind
  commandInput: unknown
  documentId: string
  number: string
  issuedAt: Date
  method?: "email" | "manual"
  preview?: boolean
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
    yield* lockDocument("invoice", input.documentId)
    const invoice = yield* Effect.promise(() => db.invoice.findFirst({
      where: { id: input.documentId, organizationId },
      include: { contact: { include: { taxIds: true } }, items: { orderBy: { sortOrder: "asc" } } },
    }))
    if (!invoice) return yield* new NotFound({ message: "Invoice not found", entity: "invoice", id: input.documentId })
    if (!input.preview && invoice.purpose === "prepayment") return yield* new InvalidState({ code: "purpose_issuance_not_supported", message: "Prepayment issuance is not supported yet" })
    // Payment details are always the ones valid now, also for agreement invoices, which keep the
    // agreed seller identity but are paid to the account in force when they are issued.
    const seller = withInvoicePaymentDetails(
      invoice.agreementId ? { ...parseSellerSnapshot(invoice.sellerSnapshot), taxIds: sellerTaxIds } : buildSellerSnapshot(settings, sellerTaxIds),
      settings
    )
    const refreshedBuyer = buildBuyerSnapshot(invoice.contact)
    const buyer = invoice.agreementId ? { ...parseBuyerSnapshot(invoice.buyerSnapshot), taxIds: refreshedBuyer.taxIds } : refreshedBuyer
    if (!input.preview && invoice.calculationVersion === "v2" && !invoice.supplyDate && !(input.commandInput as { supplyDate?: string }).supplyDate) return yield* new InvalidState({ code: "supply_date_required", message: "Confirm a supply date before issuing a v2 invoice" })
    if (!input.preview) yield* requireVatIssuance({ ...invoice, sellerSnapshot: seller, buyerSnapshot: buyer })
    const money = input.preview ? undefined : yield* Effect.try({ try: () => invoiceMoneySnapshot(invoice, { ...(input.commandInput as { supplyDate?: string; exchangeRate?: string; rateDate?: string }), number: input.number, issuedAt: input.issuedAt, baseCurrency: settings.baseCurrency, seller: seller ?? buildSellerSnapshot(settings, sellerTaxIds), buyer }), catch: error => error instanceof InvalidState ? error : new InvalidState({ code: "money_snapshot_unavailable", message: "The document's currency or frozen money components cannot be valued" }) })
    // The reference a bank transfer is matched by: the invoice's own, else its number. A draft preview has no number yet.
    const paymentReference = invoice.paymentReference?.trim() || (input.preview ? null : input.number)
    // The date the issued invoice carries, which the issuing command may have set; else the draft's.
    const supplyDate = money ? money.supplyDate : invoice.supplyDate?.toISOString().slice(0, 10) ?? null
    // All PDF fields, including branding and the intended customer, are frozen here.
    const pdfInvoice: InvoiceForPdf = {
      number: input.number, status: "sent", issueDate: base.issuedAt, dueDate: invoice.dueDate.toISOString(),
      subtotal: num(invoice.subtotalNet), taxAmount: num(invoice.totalTax), total: num(invoice.totalGross),
      currency: invoice.currency, notes: invoice.notes, ...(seller.bankAccount ? { bankAccount: seller.bankAccount } : {}), ...(seller.paymentNote ? { paymentNote: seller.paymentNote } : {}),
      // Frozen with the rest of the payment details; absent without them, so the render input of an
      // organization without payment details is unchanged. A draft preview has no number yet.
      ...(seller.bankAccount || seller.paymentNote ? { paymentReference } : {}),
      contact: { ...buyer, name: buyer?.name ?? invoice.contact.name },
      // The lines state amounts on the document's own price basis, so prices excluding VAT add up to the subtotal.
      pricesIncludeTax: invoice.pricesIncludeTax,
      ...(supplyDate ? { supplyDate } : {}),
      vatRows: frozenVatRows(invoice),
      items: invoice.items.map(line => { const shown = lineAmounts(priceBasis(invoice.pricesIncludeTax), line)
        return { description: line.description, quantity: num(line.quantity), unitPrice: num(shown.unitPrice), total: num(shown.amount) } }),
    }
    return { ...base, kind: "invoice" as const, recipient: invoice.contact.email?.trim() || null,
      ...(money ? { ubl: frozenEinvoiceInput({ kind: "invoice", money, contact: invoice.contact, countryCode: invoice.countryCode, dueDate: money.dueDate, orderReference: invoice.purchaseOrderRef, paymentReference, billingReference: null, note: invoice.notes, lines: invoice.items.map(line => ({ description: line.description, quantity: line.quantity.toString(), unitPriceNet: line.unitPriceNet.toString(), lineNet: line.lineNet.toString(), taxRate: line.taxRate.toString(), taxCategory: line.taxCategory, vatTreatment: line.vatTreatment, vatCountry: line.vatCountry, vatReasonCode: line.vatReasonCode, vatRateInput: line.vatRateInput })) }) } : {}),
      snapshot: { ...(money ? { money } : {}), purpose: invoice.purpose, agreementId: invoice.agreementId, seller, buyer: pdfInvoice.contact,
        invoice: pdfInvoice, items: invoice.items, supplyDate: invoice.supplyDate,
        pricesIncludeTax: invoice.pricesIncludeTax, countryCode: invoice.countryCode,
        taxRegime: invoice.taxRegime, paymentReference: invoice.paymentReference,
        purchaseOrderRef: invoice.purchaseOrderRef },
      pdf: { invoice: pdfInvoice, org: { ...org, ...(invoice.agreementId ? { companyName: seller?.companyName, companyEmail: seller?.companyEmail, companyAddress: seller?.companyAddress } : {}), locale: invoice.locale, timezone: invoice.timezone } } }
  }
  if (input.kind === "creditNote") {
    const selection = creditNoteIssueInputSchema.parse(input.commandInput)
    yield* lockDocument("invoice", selection.invoiceId)
    const invoice = yield* Effect.promise(() => db.invoice.findFirst({
      where: { id: selection.invoiceId, organizationId },
      include: { contact: { include: { taxIds: true } }, items: { orderBy: { sortOrder: "asc" } },
        payments: { where: { voidedAt: null }, select: { amount: true } },
        creditNotes: { where: { status: "issued" }, include: { items: true } } },
    }))
    if (!invoice) return yield* new NotFound({ message: "Invoice not found", entity: "invoice", id: selection.invoiceId })
    const built = yield* priceCreditNote(invoice, selection)
    const sellerSnapshot = withoutPaymentDetails(invoice.sellerSnapshot) ?? buildSellerSnapshot(settings, sellerTaxIds)
    const buyerSnapshot = invoice.buyerSnapshot ?? buildBuyerSnapshot(invoice.contact)
    const money = creditMoneySnapshot(invoice, { id: input.documentId, number: input.number, issuedAt: input.issuedAt, baseCurrency: settings.baseCurrency, reason: selection.reason, mode: selection.mode, built, hasPayments: invoice.payments.length > 0, paid: invoice.payments.reduce((sum, payment) => sum.plus(payment.amount), toDecimal(0)).toString(), priorCredits: invoice.creditNotes.reduce((sum, credit) => sum.plus(credit.totalGross), toDecimal(0)).toString(), seller: parseSellerSnapshot(sellerSnapshot) ?? {}, buyer: parseBuyerSnapshot(buyerSnapshot) ?? {} })
    const creditNote: CreditNoteForPdf = {
      number: input.number, issueDate: base.issuedAt, reason: selection.reason,
      subtotal: built.subtotalNet, taxAmount: built.totalTax, total: built.totalGross,
      currency: invoice.currency, locale: invoice.locale, timezone: invoice.timezone,
      sellerSnapshot, buyerSnapshot, contact: { ...buildBuyerSnapshot(invoice.contact), name: invoice.contact.name },
      invoice: { number: issuedNumber(invoice), issueDate: invoice.issueDate.toISOString() },
      // Credit notes mirror the basis of the invoice they credit.
      pricesIncludeTax: invoice.pricesIncludeTax,
      vatRows: vatRowsByRate((built.creditedGroups ?? []).map(group => ({ rate: group.original.rate,
        net: group.creditedNet, tax: group.creditedTax, gross: group.creditedGross })), invoice.currency),
      items: built.lines.map(line => { const shown = lineAmounts(priceBasis(invoice.pricesIncludeTax), line)
        return { description: line.description, quantity: line.quantity, unitPrice: shown.unitPrice, total: shown.amount } }),
    }
    return { ...base, kind: "creditNote" as const, recipient: null,
      selectionFingerprint: createHash("sha256").update(canonicalizeOffer(selection)).digest("hex"),
      ubl: frozenEinvoiceInput({ kind: "creditNote", money: money as unknown as InvoiceMoneySnapshot, contact: invoice.contact, countryCode: invoice.countryCode, dueDate: null, orderReference: invoice.purchaseOrderRef, billingReference: { number: issuedNumber(invoice), issueDate: formatIsoDate(invoice.issueDate, invoice.timezone) }, note: selection.reason, lines: built.lines.map(line => ({ ...line, quantity: String(line.quantity), unitPriceNet: String(line.unitPriceNet), lineNet: String(line.lineNet), taxRate: String(line.taxRate) })) }),
      snapshot: { money, sellerSnapshot, buyerSnapshot, built, invoiceId: invoice.id,
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
