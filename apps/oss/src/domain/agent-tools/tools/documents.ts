import { Prisma } from "../../../../generated/prisma/client"
import { getPublicInvoicePaymentUrl } from "../../../lib/payments/public"
import { getPublicQuoteUrl } from "../../../lib/quotes/public-url"

type Money = Prisma.Decimal

type LineItem = {
  description: string
  quantity: Money
  unitPriceNet: Money
  unitPriceGross: Money
  lineNet: Money
  lineTax: Money
  lineGross: Money
  taxRate: Money
}

function presentLines(items: LineItem[]) {
  return items.map((item) => ({
    description: item.description,
    quantity: item.quantity,
    unitPriceNet: item.unitPriceNet,
    unitPriceGross: item.unitPriceGross,
    lineNet: item.lineNet,
    lineTax: item.lineTax,
    lineGross: item.lineGross,
    taxRate: item.taxRate,
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
  id: string
  number: string
  status: string
  paymentStatus: string
  contactId: string
  issueDate: Date
  dueDate: Date
  currency: string
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
    contact: invoice.contact
      ? { id: invoice.contact.id ?? invoice.contactId, name: invoice.contact.name, email: invoice.contact.email }
      : { id: invoice.contactId },
    issueDate: invoice.issueDate,
    dueDate: invoice.dueDate,
    currency: invoice.currency,
    subtotalNet: invoice.subtotalNet,
    totalTax: invoice.totalTax,
    totalGross: invoice.totalGross,
    amountPaid,
    amountCredited,
    balanceDue: invoice.totalGross.minus(amountPaid).minus(amountCredited),
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
  number: string
  status: string
  contactId: string
  issueDate: Date
  expiryDate: Date
  currency: string
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
  invoices?: Array<{ id: string; number: string }>
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
