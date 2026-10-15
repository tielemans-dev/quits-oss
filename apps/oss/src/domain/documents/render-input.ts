import { invoiceAllowsPayment } from "../../lib/payments/invoice-methods"
import { hasInvoiceBankTransfer } from "../../lib/payments/bank-transfer"
import { resolveInvoiceEmailContext } from "./invoice-email"
import { requireDepositsEnabled, requireDepositInvoiceEnabled } from "../agreements/deposit-capability"
import { requireInvoiceIssuancePolicy } from "./issuance-policy"
import { frozenEinvoiceInput } from "./einvoice-input"
import { vatRowsByRate } from "./frozen-vat-groups"
import { documentVatSummary } from "./vat-summary"
import { impliedTaxRate } from "./pricing"
import { lineAmounts, nominalLineTaxRate, priceBasis } from "../../lib/documents/line-amounts"
import { formatIsoDate } from "../../lib/exports/format"
import { withNonVatStatement } from "../../lib/documents/non-vat-note"
import { requireVatIssuance, requireSellerVatIssuance } from "./vat-issuance"
import { toDecimal } from "../../lib/exports/format"
import { parseBuyerSnapshot, parseSellerSnapshot } from "@quits/contracts/documents"
import { invoiceMoneySnapshot, creditMoneySnapshot, type InvoiceMoneySnapshot } from "./money-snapshot"
import { lockDocument } from "./locks"
import { requireInvoiceSendReview } from "../approval-contexts"
import { createHash } from "node:crypto"
import { Effect } from "effect"
import type { InvoicePdfDocument, OrgSettingsForPdf } from "../../lib/invoice-pdf"
import type { CreditNoteForPdf } from "../../lib/credit-note-pdf"
import type { AgreementPdfInput } from "../../lib/agreement-pdf"
import { buildOfferSnapshot, canonicalizeOffer, hashOfferSnapshot } from "../agreements/snapshot"
import { creditNoteIssueInputSchema } from "@quits/contracts/credit-notes"
import { buildBuyerSnapshot, buildSellerSnapshot, withSellerVatStatus, withInvoicePaymentDetails, creditSellerSnapshot } from "./snapshots"
import { loadDocumentContext } from "./context"
import { priceCreditNote } from "./credit-pricing"
import { InvalidState, NotFound } from "../errors"
import { Command, Db } from "../services"
import { issuedNumber } from "./numbering"
import { translate } from "../../lib/i18n/translate"

type InvoiceForPdf = import("react").ComponentProps<typeof InvoicePdfDocument>["invoice"]

/** The credit note's own first positive rate, independent of uncredited invoice lines. */
export const creditNoteMainRate = (_invoice: Parameters<typeof impliedTaxRate>[0], creditedRates: readonly number[]) => nominalLineTaxRate(creditedRates) ?? 0

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
    const reviewedVersion = (input.commandInput as { reviewedVersion?: string }).reviewedVersion
    if (!input.preview && reviewedVersion) {
      yield* lockDocument("contact", invoice.contactId, { strength: "no_key_update" })
      invoice.contact = yield* Effect.promise(() => db.contact.findFirstOrThrow({
        where: { id: invoice.contactId, organizationId }, include: { taxIds: true },
      }))
      yield* requireInvoiceSendReview(invoice, { settings, sellerTaxIds }, reviewedVersion)
    }
    // Checked before preparation and again under the commit locks. Empty drafts may still be previewed.
    if (!input.preview && !invoice.items.length) return yield* new InvalidState({ code: "empty_invoice", message: "Add at least one line before sending this invoice." })
    if (!input.preview) yield* requireDepositInvoiceEnabled(invoice)
    if (!input.preview && invoice.purpose === "prepayment") return yield* new InvalidState({ code: "purpose_issuance_not_supported", message: "Prepayment issuance is not supported yet" })
    // Payment details are always the ones valid now, also for agreement invoices, which keep the
    // agreed seller identity but are paid to the account in force when they are issued.
    const currentSeller = buildSellerSnapshot(settings, sellerTaxIds)
    const effectiveSeller = (invoice.agreementId || invoice.quoteId)
      ? yield* withSellerVatStatus(parseSellerSnapshot(invoice.sellerSnapshot) ?? {}, currentSeller, invoice.taxRegime)
      : currentSeller
    const seller = withInvoicePaymentDetails(effectiveSeller, settings, invoice.locale, invoice.paymentMethods)
    const refreshedBuyer = buildBuyerSnapshot(invoice.contact)
    const buyer = (invoice.agreementId || invoice.quoteId) ? parseBuyerSnapshot(invoice.buyerSnapshot) ?? {} : refreshedBuyer
    if (!input.preview && invoice.calculationVersion === "v2" && !invoice.supplyDate && !(input.commandInput as { supplyDate?: string }).supplyDate) return yield* new InvalidState({ code: "supply_date_required", message: "Confirm a supply date before issuing a v2 invoice" })
    if (!input.preview) yield* requireInvoiceIssuancePolicy(organizationId, { ...invoice, sellerSnapshot: seller, buyerSnapshot: buyer, supplyDate: (input.commandInput as { supplyDate?: string }).supplyDate ?? invoice.supplyDate, paymentAvailable: (invoiceAllowsPayment(invoice.paymentMethods, "card") && resolveInvoiceEmailContext(settings).stripeConfigured) || hasInvoiceBankTransfer(seller) })
    if (!input.preview) yield* requireVatIssuance({ ...invoice, sellerSnapshot: seller, buyerSnapshot: buyer })
    const money = input.preview ? undefined : yield* Effect.try({ try: () => invoiceMoneySnapshot(invoice, { ...(input.commandInput as { supplyDate?: string; exchangeRate?: string; rateDate?: string }), number: input.number, issuedAt: input.issuedAt, baseCurrency: settings.baseCurrency, seller: seller ?? buildSellerSnapshot(settings, sellerTaxIds), buyer }), catch: error => error instanceof InvalidState ? error : new InvalidState({ code: "money_snapshot_unavailable", message: "The document's currency or frozen money components cannot be valued" }) })
    // The reference a bank transfer is matched by: the invoice's own, else its number. A draft preview has no number yet.
    const paymentReference = invoice.paymentReference?.trim() || (input.preview ? null : input.number)
    // An issued invoice's rows are its frozen money groups, the ones the e-invoice carries; a draft's are grouped from its lines.
    const { vatRows, rounding } = documentVatSummary(invoice, money ? vatRowsByRate(money.vatGroups, invoice.currency) : undefined)
    // The date the issued invoice carries, which the issuing command may have set; else the draft's.
    const supplyDate = money ? money.supplyDate : invoice.supplyDate?.toISOString().slice(0, 10) ?? null
    // All PDF fields, including branding and the intended customer, are frozen here.
    const pdfInvoice: InvoiceForPdf = {
      number: input.number, status: "sent", issueDate: base.issuedAt, dueDate: invoice.dueDate.toISOString(),
      taxRate: impliedTaxRate(invoice), subtotal: num(invoice.subtotalNet), taxAmount: num(invoice.totalTax), total: num(invoice.totalGross),
      currency: invoice.currency, taxRegime: invoice.taxRegime, notes: invoice.notes, momsRegistered: seller.momsRegistered, ...(seller.bankAccount ? { bankAccount: seller.bankAccount } : {}), ...(seller.paymentNote ? { paymentNote: seller.paymentNote } : {}),
      // Frozen with the rest of the payment details; absent without them, so the render input of an
      // organization without payment details is unchanged. A draft preview has no number yet.
      ...(seller.bankAccount || seller.paymentNote ? { paymentReference } : {}),
      contact: { ...buyer, name: buyer?.name ?? "" },
      // Full invoices state stored net unit prices regardless of the entry basis.
      pricesIncludeTax: false,
      ...(supplyDate ? { supplyDate } : {}),
      ...(vatRows ? { vatRows } : {}),
      rounding,
      items: invoice.items.map(line => { const shown = lineAmounts("net", line)
        return { description: line.description, quantity: num(line.quantity), unitPrice: num(shown.unitPrice), total: num(shown.amount), taxRate: num(line.taxRate) } }),
    }
    return { ...base, kind: "invoice" as const, recipient: invoice.contact.email?.trim() || null,
      ...(money && !money.vatGroups.some(group => group.treatment === "unclassified_zero") ? { ubl: frozenEinvoiceInput({ kind: "invoice", taxRegime: invoice.taxRegime, money, contact: invoice.contact, countryCode: invoice.countryCode, locale: invoice.locale, dueDate: money.dueDate, orderReference: invoice.purchaseOrderRef, paymentReference, billingReference: null, note: invoice.notes, lines: invoice.items.map(line => ({ description: line.description, quantity: line.quantity.toString(), unitPriceNet: line.unitPriceNet.toString(), lineNet: line.lineNet.toString(), taxRate: line.taxRate.toString(), taxCategory: line.taxCategory, vatTreatment: line.vatTreatment, vatCountry: line.vatCountry, vatReasonCode: line.vatReasonCode, vatRateInput: line.vatRateInput })) }) } : {}),
      snapshot: { ...(money ? { money } : {}), purpose: invoice.purpose, agreementId: invoice.agreementId, seller, buyer: pdfInvoice.contact,
        invoice: pdfInvoice, items: invoice.items, supplyDate: invoice.supplyDate,
        pricesIncludeTax: invoice.pricesIncludeTax, countryCode: invoice.countryCode,
        taxRegime: invoice.taxRegime, paymentReference: invoice.paymentReference,
        purchaseOrderRef: invoice.purchaseOrderRef },
      pdf: { invoice: pdfInvoice, org: { ...org, companyName: seller.companyName, companyEmail: seller.companyEmail, companyAddress: seller.companyAddress, taxIds: seller.taxIds, locale: invoice.locale, timezone: invoice.timezone,
        ...(seller.momsRegistered === false ? { cvrLabel: translate("pdf.cvrNumber", invoice.locale) } : {}),
      } } }
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
    const sellerSnapshot = creditSellerSnapshot(invoice.sellerSnapshot, settings, sellerTaxIds)
    const buyerSnapshot = invoice.buyerSnapshot ?? buildBuyerSnapshot(invoice.contact)
    const money = creditMoneySnapshot(invoice, { id: input.documentId, number: input.number, issuedAt: input.issuedAt, baseCurrency: settings.baseCurrency, reason: selection.reason, mode: selection.mode, built, hasPayments: invoice.payments.length > 0, paid: invoice.payments.reduce((sum, payment) => sum.plus(payment.amount), toDecimal(0)).toString(), priorCredits: invoice.creditNotes.reduce((sum, credit) => sum.plus(credit.totalGross), toDecimal(0)).toString(), seller: parseSellerSnapshot(sellerSnapshot) ?? {}, buyer: parseBuyerSnapshot(buyerSnapshot) ?? {} })
    // The credited groups, validated against the credit note's own stored totals.
    const creditSummary = documentVatSummary({ currency: invoice.currency, subtotalNet: String(built.subtotalNet), totalTax: String(built.totalTax), totalGross: String(built.totalGross) },
      vatRowsByRate((built.creditedGroups ?? []).map(group => ({ rate: group.original.rate, treatment: group.original.treatment, reasonCode: group.original.reasonCode, evidence: group.original.evidence, net: group.creditedNet, tax: group.creditedTax, gross: group.creditedGross })), invoice.currency))
    const creditVatSummary = { ...(creditSummary.vatRows ? { vatRows: creditSummary.vatRows } : {}), rounding: creditSummary.rounding }
    const creditNote: CreditNoteForPdf = {
      number: input.number, issueDate: base.issuedAt, reason: withNonVatStatement(selection.reason, money.seller.momsRegistered, invoice.locale) ?? selection.reason,
      taxRate: creditNoteMainRate(invoice, built.lines.map(line => line.taxRate)), subtotal: built.subtotalNet, taxAmount: built.totalTax, total: built.totalGross,
      currency: invoice.currency, taxRegime: invoice.taxRegime, locale: invoice.locale, timezone: invoice.timezone,
      sellerSnapshot, buyerSnapshot, contact: { ...buildBuyerSnapshot(invoice.contact), name: invoice.contact.name },
      invoice: { number: issuedNumber(invoice), issueDate: invoice.issueDate.toISOString() },
      // Credit notes mirror the basis of the invoice they credit.
      pricesIncludeTax: invoice.pricesIncludeTax,
      ...creditVatSummary,
      items: built.lines.map(line => { const shown = lineAmounts(priceBasis(invoice.pricesIncludeTax), line)
        return { description: line.description, quantity: line.quantity, unitPrice: shown.unitPrice, total: shown.amount, taxRate: line.taxRate } }),
    }
    return { ...base, kind: "creditNote" as const, recipient: null,
      selectionFingerprint: createHash("sha256").update(canonicalizeOffer(selection)).digest("hex"),
      ...(money.vatGroups.some(group => group.treatment === "unclassified_zero") ? {} : { ubl: frozenEinvoiceInput({ kind: "creditNote", taxRegime: invoice.taxRegime, money: money as unknown as InvoiceMoneySnapshot, contact: invoice.contact, countryCode: invoice.countryCode, locale: invoice.locale, dueDate: null, orderReference: invoice.purchaseOrderRef, billingReference: { number: issuedNumber(invoice), issueDate: formatIsoDate(invoice.issueDate, invoice.timezone) }, note: selection.reason, lines: built.lines.map(line => ({ ...line, quantity: String(line.quantity), unitPriceNet: String(line.unitPriceNet), lineNet: String(line.lineNet), taxRate: String(line.taxRate) })) }) }),
      snapshot: { money, sellerSnapshot, buyerSnapshot, built, invoiceId: invoice.id,
        currency: invoice.currency, countryCode: invoice.countryCode, locale: invoice.locale,
        timezone: invoice.timezone, taxRegime: invoice.taxRegime, pricesIncludeTax: invoice.pricesIncludeTax },
      pdf: { creditNote, org } }
  }
  yield* lockDocument("agreement", input.documentId)
  const agreement = yield* Effect.promise(() => db.agreement.findFirst({
    where: { id: input.documentId, organizationId }, include: { contact: true, deliverables: { orderBy: { sortOrder: "asc" } } },
  }))
  if (!agreement) return yield* new NotFound({ message: "Agreement not found", entity: "agreement", id: input.documentId })
  if (!input.preview) yield* requireDepositsEnabled(agreement.deliverables)
  const commandInput = input.commandInput as { recipient?: string }
  const recipient = input.method === "manual" ? commandInput.recipient ?? null : agreement.contact.email?.trim() || null
  const sellerSnapshot = buildSellerSnapshot(settings, sellerTaxIds)
  if (!input.preview) yield* requireSellerVatIssuance({ ...agreement, sellerSnapshot, items: agreement.deliverables.filter(line => line.status !== "cancelled") })
  const snapshot = buildOfferSnapshot({ ...agreement,
    sellerSnapshot, buyerSnapshot: buildBuyerSnapshot(agreement.contact) })
  // The offer's issuance date remains unchanged on an unchanged retry, just as before A3a.
  const issuedAt = agreement.offerSnapshotHash === hashOfferSnapshot(snapshot) && agreement.issuedToEmail === recipient
    ? agreement.issueDate?.toISOString() ?? base.issuedAt : base.issuedAt
  return { ...base, kind: "agreement" as const, issuedAt, recipient, snapshot,
    pdf: { snapshot, number: input.number, issueDate: issuedAt } }
})
