import { percentageToFraction } from "@quits/shared/pricing"
import { Prisma } from "../../../../generated/prisma/client"
import { getPublicInvoicePaymentUrl } from "../../../lib/payments/public"
import { getPublicQuoteUrl } from "../../../lib/quotes/public-url"
import { computeSettlement } from "../../documents/settlement"

type Money = Prisma.Decimal

type LineItem = {
  id?: string
  deliverableId?: string | null
  description: string
  quantity: Money
  unitPriceNet: Money
  unitPriceGross: Money
  lineNet: Money
  lineTax: Money
  lineGross: Money
  taxRate: Money
  quantityInput?: string | null
  unitPriceInput?: string | null
  inputPrecision?: string | null
  vatTreatment?: string
  vatRateInput?: string | null
  vatCountry?: string | null
  vatReasonCode?: string | null
}

function presentLines(items: LineItem[]) {
  return items.map((item) => ({
    id: item.id,
    deliverableId: item.deliverableId ?? null,
    description: item.description,
    quantity: item.quantity,
    unitPriceNet: item.unitPriceNet,
    unitPriceGross: item.unitPriceGross,
    lineNet: item.lineNet,
    lineTax: item.lineTax,
    lineGross: item.lineGross,
    taxRate: item.taxRate,
    quantityInput: item.quantityInput ?? null,
    unitPriceInput: item.unitPriceInput ?? null,
    inputPrecision: item.inputPrecision ?? null,
    vat: { treatment: item.vatTreatment ?? (item.taxRate.toNumber() > 0 ? "standard" : "unclassified_zero"), rate: item.vatRateInput ?? percentageToFraction(item.taxRate.toString()), country: item.vatCountry ?? null, reasonCode: item.vatReasonCode ?? null },
  }))
}

/** Public links need signing secrets; a missing secret must not break a read. */
function safely<T>(build: () => T): T | null {
  try {
    return build()
  } catch {
    return null
  }
}

export type InvoiceRow = {
  disputed?: boolean
  disputedRevision?: number
  purpose?: string
  agreementId?: string | null
  scheduleSaleChoice?: unknown
  id: string
  /** Null while the invoice is a draft: it is numbered when it is issued. */
  number: string | null
  status: string
  paymentStatus: string
  contactId: string
  issueDate: Date
  dueDate: Date
  supplyDate?: Date | null
  valuation?: unknown
  issuanceSnapshot?: unknown
  currency: string
  calculationVersion?: string
  vatEvidence?: unknown
  subtotalNet: Money
  totalTax: Money
  totalGross: Money
  amountPaid?: Money
  amountCredited?: Money
  remindersPaused?: boolean
  publicPaymentIssuedAt: Date | null
  publicPaymentKeyVersion: number
  lastEmailAttemptOutcome?: string | null
  lastEmailAttemptMessage?: string | null
  notes?: string | null
  quoteId?: string | null
  recurringInvoiceId?: string | null
  createdAt: Date
  updatedAt: Date
  contact?: { id?: string; name: string; email?: string | null } | null
  items?: LineItem[]
}

/** Agents see balances directly instead of recomputing them. */
export function presentInvoice(invoice: InvoiceRow) {
  const amountPaid = invoice.amountPaid ?? new Prisma.Decimal(0)
  const amountCredited = invoice.amountCredited ?? new Prisma.Decimal(0)
  return {
    id: invoice.id,
    number: invoice.number,
    status: invoice.status,
    paymentStatus: invoice.paymentStatus,
    disputed: invoice.disputed ?? false,
    disputedRevision: invoice.disputedRevision ?? 0,
    purpose: invoice.purpose ?? "sale",
    agreementId: invoice.agreementId ?? null,
    supplyDate: invoice.supplyDate ?? null,
    valuation: invoice.valuation ?? { rateSource: "unknown" },
    issuanceSnapshot: invoice.issuanceSnapshot ?? null,
    scheduleSaleChoice: invoice.scheduleSaleChoice ?? null,
    contact: invoice.contact
      ? { id: invoice.contact.id ?? invoice.contactId, name: invoice.contact.name, email: invoice.contact.email }
      : { id: invoice.contactId },
    issueDate: invoice.issueDate,
    dueDate: invoice.dueDate,
    currency: invoice.currency,
    calculationVersion: invoice.calculationVersion ?? "legacy_per_line",
    vatEvidence: invoice.vatEvidence ?? null,
    subtotalNet: invoice.subtotalNet,
    totalTax: invoice.totalTax,
    totalGross: invoice.totalGross,
    amountPaid,
    amountCredited,
    // The same balance the rest of the app shows: never negative, even after an overpayment.
    balanceDue: computeSettlement({ totalGross: invoice.totalGross, amountPaid, amountCredited }).balanceDue,
    remindersPaused: invoice.remindersPaused ?? false,
    lastEmailAttempt: invoice.lastEmailAttemptOutcome
      ? { outcome: invoice.lastEmailAttemptOutcome, message: invoice.lastEmailAttemptMessage ?? null }
      : null,
    publicPaymentUrl: safely(() => getPublicInvoicePaymentUrl(invoice)),
    quoteId: invoice.quoteId ?? null,
    recurringInvoiceId: invoice.recurringInvoiceId ?? null,
    notes: invoice.notes ?? null,
    createdAt: invoice.createdAt,
    updatedAt: invoice.updatedAt,
    ...(invoice.items ? { items: presentLines(invoice.items) } : {}),
  }
}

export type QuoteRow = {
  id: string
  /** Null while the quote is a draft: it is numbered when it is sent. */
  number: string | null
  status: string
  contactId: string
  issueDate: Date
  expiryDate: Date
  currency: string
  calculationVersion?: string
  vatEvidence?: unknown
  subtotalNet: Money
  totalTax: Money
  totalGross: Money
  publicAccessIssuedAt: Date | null
  publicAccessKeyVersion: number
  publicDecisionAt?: Date | null
  publicRejectionReason?: string | null
  notes?: string | null
  createdAt: Date
  updatedAt: Date
  contact?: { id?: string; name: string; email?: string | null } | null
  items?: LineItem[]
  invoices?: Array<{ id: string; number: string | null }>
}

export function presentQuote(quote: QuoteRow) {
  return {
    id: quote.id,
    number: quote.number,
    status: quote.status,
    contact: quote.contact
      ? { id: quote.contact.id ?? quote.contactId, name: quote.contact.name, email: quote.contact.email }
      : { id: quote.contactId },
    issueDate: quote.issueDate,
    expiryDate: quote.expiryDate,
    currency: quote.currency,
    calculationVersion: quote.calculationVersion ?? "legacy_per_line",
    vatEvidence: quote.vatEvidence ?? null,
    subtotalNet: quote.subtotalNet,
    totalTax: quote.totalTax,
    totalGross: quote.totalGross,
    decidedAt: quote.publicDecisionAt ?? null,
    rejectionReason: quote.publicRejectionReason ?? null,
    publicViewUrl: safely(() => getPublicQuoteUrl(quote)),
    notes: quote.notes ?? null,
    createdAt: quote.createdAt,
    updatedAt: quote.updatedAt,
    ...(quote.items ? { items: presentLines(quote.items) } : {}),
    ...(quote.invoices ? { invoices: quote.invoices } : {}),
  }
}
