import { createServerFn } from "@tanstack/react-start"
import { z } from "zod"
import {
  parseBuyerSnapshot,
  parseSellerSnapshot,
} from "@quits/contracts/documents"
import {
  publicQuoteTokenInputSchema,
} from "@quits/contracts/quotes"
import { invalidLinkLocale } from "../documents/public-invalid-link"
import { publicLogoPath } from "../documents/public-logo"
import { resolvePublicPresentation } from "../documents/public-presentation"
import { issuedNumber } from "../../domain/documents/numbering"

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

/** `token` is the link the page was opened with: an uploaded logo is served from its logo route. */
export function serializePublicQuoteSession(session: {
  quote: {
    id: string
    number: string | null
    status: string
    issueDate: Date | string
    expiryDate: Date | string
    totalGross: Decimalish
    totalTax: Decimalish
    subtotalNet: Decimalish
    currency: string
    /** The document's own language and timezone, the ones its PDF and email use. */
    locale?: string | null
    timezone?: string | null
    notes: string | null
    sellerSnapshot: unknown
    buyerSnapshot: unknown
    /** Only the presentation fields are read from the seller's settings. */
    organization?: {
      settings?: {
        locale?: string | null
        timezone?: string | null
        companyName?: string | null
        companyLogo?: string | null
      } | null
    } | null
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
      number: string | null
      status: string
    }>
  }
  decisionState: "pending" | "accepted" | "rejected"
}, token: string) {
  const { quote } = session
  const sellerSnapshot = parseSellerSnapshot(quote.sellerSnapshot)
  const presentation = resolvePublicPresentation({
    document: { locale: quote.locale, timezone: quote.timezone, sellerSnapshot },
    settings: quote.organization?.settings,
    logoPath: publicLogoPath("q", token),
  })

  return {
    /** The language the page is shown in. */
    locale: presentation.locale,
    seller: presentation.seller,
    decisionState: session.decisionState,
    quote: {
      id: quote.id,
      // Public links exist only for sent quotes, which always have a number.
      number: issuedNumber(quote),
      status: quote.status,
      issueDate: toDateString(quote.issueDate) ?? quote.issueDate,
      expiryDate: toDateString(quote.expiryDate) ?? quote.expiryDate,
      totalGross: toNumber(quote.totalGross),
      totalTax: toNumber(quote.totalTax),
      subtotalNet: toNumber(quote.subtotalNet),
      currency: quote.currency,
      timezone: presentation.timezone,
      notes: quote.notes,
      sellerSnapshot,
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
      // A draft invoice is not the customer's to see; it has no number until it is issued.
      invoices: quote.invoices.flatMap((invoice) =>
        invoice.number === null || invoice.status === "draft" ? [] : [{ ...invoice, number: invoice.number }]
      ),
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
      // No document to take a language from: answer in the visitor's.
      return { kind: "invalid", locale: invalidLinkLocale() } as const
    }

    return {
      kind: "ready",
      ...serializePublicQuoteSession(session, data.token),
    } as const
  })

export const submitPublicQuoteDecision = createServerFn({ method: "POST" })
  // Count refusals after verifying the signed identity, before business validation.
  .inputValidator(
    publicQuoteTokenInputSchema
      .extend({ decision: z.unknown(), rejectionReason: z.unknown().optional() })
      .strict()
  )
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
        ...serializePublicQuoteSession(session, data.token),
      } as const
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "retry_later") {
        return { kind: "retry_later" } as const
      }
      return { kind: "invalid" } as const
    }
  })
