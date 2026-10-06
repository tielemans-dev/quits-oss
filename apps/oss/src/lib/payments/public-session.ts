import { createServerFn } from "@tanstack/react-start"
import {
  parseBuyerSnapshot,
  parseSellerSnapshot,
} from "@yaip/contracts/documents"
import {
  publicInvoiceCheckoutResultSchema,
  publicInvoiceTokenInputSchema,
} from "@yaip/contracts/payments"

type Decimalish = number | { toNumber(): number }

function toNumber(value: Decimalish) {
  return typeof value === "number" ? value : value.toNumber()
}

function toDateString(value: Date | string) {
  return value instanceof Date ? value.toISOString() : value
}

export function serializePublicInvoiceSession(session: {
  invoice: {
    id: string
    number: string
    status: string
    paymentStatus: string
    issueDate: Date | string
    dueDate: Date | string
    totalGross: Decimalish
    totalTax: Decimalish
    subtotalNet: Decimalish
    currency: string
    notes: string | null
    sellerSnapshot: unknown
    buyerSnapshot: unknown
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
}) {
  const { invoice } = session

  return {
    paymentState: session.paymentState,
    stripeEnabled: session.stripeEnabled,
    invoice: {
      id: invoice.id,
      number: invoice.number,
      status: invoice.status,
      paymentStatus: invoice.paymentStatus,
      issueDate: toDateString(invoice.issueDate),
      dueDate: toDateString(invoice.dueDate),
      totalGross: toNumber(invoice.totalGross),
      totalTax: toNumber(invoice.totalTax),
      subtotalNet: toNumber(invoice.subtotalNet),
      currency: invoice.currency,
      notes: invoice.notes,
      sellerSnapshot: parseSellerSnapshot(invoice.sellerSnapshot),
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
      return { kind: "invalid" } as const
    }

    return {
      kind: "ready",
      ...serializePublicInvoiceSession(session),
    } as const
  })

export const beginPublicInvoiceCheckout = createServerFn({ method: "POST" })
  .inputValidator(publicInvoiceTokenInputSchema)
  .handler(async ({ data }) => {
    const { resolvePublicInvoiceCheckout } = await import("./public-checkout")
    return publicInvoiceCheckoutResultSchema.parse(
      await resolvePublicInvoiceCheckout(data.token)
    )
  })
