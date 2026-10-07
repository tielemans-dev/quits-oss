import { createServerFn } from "@tanstack/react-start"
import {
  parseBuyerSnapshot,
  parseSellerSnapshot,
} from "@quits/contracts/documents"
import {
  publicQuoteDecisionInputSchema,
  publicQuoteTokenInputSchema,
} from "@quits/contracts/quotes"

type Decimalish = number | { toNumber(): number }

function toNumber(value: Decimalish) {
  return typeof value === "number" ? value : value.toNumber()
}

function toDateString(value: Date | string | null) {
  if (!value) {
    return null
  }

  return value instanceof Date ? value.toISOString() : value
}

export function serializePublicQuoteSession(session: {
  quote: {
    id: string
    number: string
    status: string
    issueDate: Date | string
    expiryDate: Date | string
    totalGross: Decimalish
    totalTax: Decimalish
    subtotalNet: Decimalish
    currency: string
    notes: string | null
    sellerSnapshot: unknown
    buyerSnapshot: unknown
    publicDecisionAt: Date | string | null
    publicRejectionReason: string | null
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
    invoices: Array<{
      id: string
      number: string
      status: string
    }>
  }
  decisionState: "pending" | "accepted" | "rejected"
}) {
  const { quote } = session

  return {
    decisionState: session.decisionState,
    quote: {
      id: quote.id,
      number: quote.number,
      status: quote.status,
      issueDate: toDateString(quote.issueDate) ?? quote.issueDate,
      expiryDate: toDateString(quote.expiryDate) ?? quote.expiryDate,
      totalGross: toNumber(quote.totalGross),
      totalTax: toNumber(quote.totalTax),
      subtotalNet: toNumber(quote.subtotalNet),
      currency: quote.currency,
      notes: quote.notes,
      sellerSnapshot: parseSellerSnapshot(quote.sellerSnapshot),
      buyerSnapshot: parseBuyerSnapshot(quote.buyerSnapshot),
      publicDecisionAt: toDateString(quote.publicDecisionAt),
      publicRejectionReason: quote.publicRejectionReason,
      contact: quote.contact,
      items: quote.items.map((item) => ({
        id: item.id,
        description: item.description,
        quantity: toNumber(item.quantity),
        unitPriceGross: toNumber(item.unitPriceGross),
        lineGross: toNumber(item.lineGross),
        sortOrder: item.sortOrder,
      })),
      invoices: quote.invoices,
    },
  }
}

export const getPublicQuoteSession = createServerFn({ method: "GET" })
  .inputValidator(publicQuoteTokenInputSchema)
  .handler(async ({ data }) => {
    const [{ loadPublicQuoteByToken }, { getPublicQuoteSecret }] = await Promise.all([
      import("./public-access"),
      import("./public-url"),
    ])
    const session = await loadPublicQuoteByToken(data.token, getPublicQuoteSecret())
    if (!session) {
      return { kind: "invalid" } as const
    }

    return {
      kind: "ready",
      ...serializePublicQuoteSession(session),
    } as const
  })

export const submitPublicQuoteDecision = createServerFn({ method: "POST" })
  .inputValidator(publicQuoteDecisionInputSchema)
  .handler(async ({ data }) => {
    try {
      const [{ decidePublicQuoteByToken }, { getPublicQuoteSecret }] = await Promise.all([
        import("./public-access"),
        import("./public-url"),
      ])
      const session = await decidePublicQuoteByToken(data.token, getPublicQuoteSecret(), {
        decision: data.decision,
        rejectionReason: data.decision === "rejected" ? data.rejectionReason : undefined,
      })

      return {
        kind: "ready",
        ...serializePublicQuoteSession(session),
      } as const
    } catch {
      return { kind: "invalid" } as const
    }
  })
