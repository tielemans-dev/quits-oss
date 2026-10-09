import { createServerFn } from "@tanstack/react-start"
import {
  parseBuyerSnapshot,
  parseSellerSnapshot,
} from "@quits/contracts/documents"
import {
  publicInvoiceCheckoutResultSchema,
  publicInvoiceTokenInputSchema,
} from "@quits/contracts/payments"
import { invalidLinkLocale } from "../documents/public-invalid-link"
import { publicLogoPath } from "../documents/public-logo"
import { resolvePublicPresentation } from "../documents/public-presentation"
import { isDocumentNotIssued, issuedNumber } from "../../domain/documents/numbering"

type Decimalish = number | { toNumber(): number }

function toNumber(value: Decimalish) {
  return typeof value === "number" ? value : value.toNumber()
}

function toDateString(value: Date | string) {
  return value instanceof Date ? value.toISOString() : value
}

/** `token` is the link the page was opened with: an uploaded logo is served from its logo route. */
export function serializePublicInvoiceSession(session: {
  invoice: {
    id: string
    number: string | null
    status: string
    paymentStatus: string
    issueDate: Date | string
    dueDate: Date | string
    totalGross: Decimalish
    amountPaid: Decimalish
    amountCredited: Decimalish
    totalTax: Decimalish
    subtotalNet: Decimalish
    currency: string
    /** The document's own language and timezone, the ones its PDF is rendered with. */
    locale?: string | null
    timezone?: string | null
    notes: string | null
    paymentReference?: string | null
    sellerSnapshot: unknown
    buyerSnapshot: unknown
    /** Only the presentation fields are read; the settings row also carries secrets. */
    organization?: {
      settings?: {
        locale?: string | null
        timezone?: string | null
        companyName?: string | null
        companyLogo?: string | null
      } | null
    } | null
    contact: {
      name: string
      email: string | null
      company: string | null
    }
    items: Array<{
      id: string
      description: string
      quantity: Decimalish
      unitPriceGross: Decimalish
      lineGross: Decimalish
      sortOrder: number
    }>
  }
  paymentState: "unpaid" | "paid"
  stripeEnabled: boolean
}, token: string) {
  const { invoice } = session
  const totalGross = toNumber(invoice.totalGross)
  const amountPaid = toNumber(invoice.amountPaid)
  const amountCredited = toNumber(invoice.amountCredited)
  const balanceDue =
    session.paymentState === "paid"
      ? 0
      : Math.max(Math.round((totalGross - amountCredited - amountPaid) * 100) / 100, 0)

  const sellerSnapshot = parseSellerSnapshot(invoice.sellerSnapshot)
  const presentation = resolvePublicPresentation({
    document: { locale: invoice.locale, timezone: invoice.timezone, sellerSnapshot },
    settings: invoice.organization?.settings,
    logoPath: publicLogoPath("pay", token),
  })

  return {
    /** The language the page is shown in. */
    locale: presentation.locale,
    seller: presentation.seller,
    paymentState: session.paymentState,
    stripeEnabled: session.stripeEnabled,
    invoice: {
      id: invoice.id,
      // Public links exist only for issued invoices, which always have a number.
      number: issuedNumber(invoice),
      status: invoice.status,
      paymentStatus: invoice.paymentStatus,
      issueDate: toDateString(invoice.issueDate),
      dueDate: toDateString(invoice.dueDate),
      totalGross,
      amountPaid,
      amountCredited,
      balanceDue,
      totalTax: toNumber(invoice.totalTax),
      subtotalNet: toNumber(invoice.subtotalNet),
      currency: invoice.currency,
      timezone: presentation.timezone,
      notes: invoice.notes,
      paymentReference: invoice.paymentReference?.trim() || issuedNumber(invoice),
      sellerSnapshot,
      buyerSnapshot: parseBuyerSnapshot(invoice.buyerSnapshot),
      contact: invoice.contact,
      items: invoice.items.map((item) => ({
        id: item.id,
        description: item.description,
        quantity: toNumber(item.quantity),
        unitPriceGross: toNumber(item.unitPriceGross),
        lineGross: toNumber(item.lineGross),
        sortOrder: item.sortOrder,
      })),
    },
  }
}

export const getPublicInvoiceSession = createServerFn({ method: "GET" })
  .inputValidator(publicInvoiceTokenInputSchema)
  .handler(async ({ data }) => {
    const [{ loadPublicInvoiceByToken }, { getPublicInvoicePaymentSecret }] = await Promise.all([
      import("./public-access"),
      import("./public"),
    ])
    const session = await loadPublicInvoiceByToken(data.token, getPublicInvoicePaymentSecret())
    if (!session) {
      // No document to take a language from: answer in the visitor's.
      return { kind: "invalid", locale: invalidLinkLocale() } as const
    }

    try {
      return {
        kind: "ready",
        ...serializePublicInvoiceSession(session, data.token),
      } as const
    } catch (error) {
      if (!isDocumentNotIssued(error)) throw error
      // A shared link whose invoice has no number is a broken invariant; show the link as invalid and say why in the log.
      const { appLogger } = await import("../observability")
      appLogger.child("payments").error("public_invoice.not_issued", { invoiceId: session.invoice.id })
      return { kind: "invalid", locale: invalidLinkLocale() } as const
    }
  })

export const beginPublicInvoiceCheckout = createServerFn({ method: "POST" })
  .inputValidator(publicInvoiceTokenInputSchema)
  .handler(async ({ data }) => {
    const { resolvePublicInvoiceCheckout } = await import("./public-checkout")
    return publicInvoiceCheckoutResultSchema.parse(
      await resolvePublicInvoiceCheckout(data.token)
    )
  })
