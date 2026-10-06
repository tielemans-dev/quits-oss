import { Effect } from "effect"
import { sendQuoteEmail } from "../../lib/email"
import { createEmailDeliveryAttempt } from "../../lib/email-delivery"
import { prisma } from "../../lib/db"
import { appLogger } from "../../lib/observability"
import { ExternalFailure } from "../errors"
import { resolveInvoiceEmailContext } from "./invoice-email"
import { Command } from "../services"

export { requireRecipientEmail } from "./invoice-email"

const quoteLogger = appLogger.child("quotes")

type Decimalish = { toNumber(): number }

type OrgEmailSettings = Parameters<typeof resolveInvoiceEmailContext>[0]

export type QuoteForEmail = {
  id: string
  number: string
  issueDate: Date
  expiryDate: Date
  currency: string
  notes: string | null
  subtotalNet: Decimalish
  totalTax: Decimalish
  totalGross: Decimalish
  contact: { name: string; email: string | null }
  items: Array<{
    description: string
    quantity: Decimalish
    unitPriceGross: Decimalish
    lineGross: Decimalish
  }>
}

/** Sender identity and whether email delivery is available. Quotes carry no pay link. */
export function resolveQuoteEmailContext(settings: OrgEmailSettings) {
  const { envelope, emailDelivery } = resolveInvoiceEmailContext(settings)
  return { envelope, emailDelivery }
}

/**
 * Sends the quote email. On failure the failed attempt is written outside the command's
 * transaction so it survives the rollback, then the command fails.
 */
export function deliverQuoteEmail(input: {
  quote: QuoteForEmail
  settings: OrgEmailSettings
  to: string
  publicQuoteUrl: string | null
  failureMessage: string
  /** Scope for the provider idempotency key; see `DeliveryOptions.idempotencyScope`. */
  idempotencyScope?: string
  failureLogEvent: string
  organizationId: string
}) {
  const { envelope } = resolveQuoteEmailContext(input.settings)
  const { quote } = input

  return Effect.tryPromise({
    try: () =>
      sendQuoteEmail({
        to: input.to,
        fromName: envelope.fromName,
        fromEmail: envelope.fromEmail,
        replyTo: envelope.replyTo,
        quote: {
          ...quote,
          subtotal: quote.subtotalNet.toNumber(),
          taxAmount: quote.totalTax.toNumber(),
          total: quote.totalGross.toNumber(),
          items: quote.items.map((item) => ({
            description: item.description,
            quantity: item.quantity.toNumber(),
            unitPrice: item.unitPriceGross.toNumber(),
            total: item.lineGross.toNumber(),
          })),
        },
        org: {
          companyName: input.settings.companyName,
          companyEmail: input.settings.companyEmail,
          locale: input.settings.locale,
          timezone: input.settings.timezone,
        },
        contactName: quote.contact.name,
        publicQuoteUrl: input.publicQuoteUrl,
      }, { idempotencyScope: input.idempotencyScope }),
    catch: (cause) => cause,
  }).pipe(
    Effect.catchAll((cause) =>
      Effect.gen(function* () {
        const command = yield* Command
        quoteLogger.error(input.failureLogEvent, {
          organizationId: input.organizationId,
          quoteId: quote.id,
          error: cause,
        })
        // Recorded after the rollback so the failed attempt survives the command failing.
        command.onRollback(() =>
          prisma.quote.update({
            where: { id: quote.id },
            data: createEmailDeliveryAttempt({
              outcome: "failed",
              code: "send_failed",
              message: "Failed to send quote email.",
            }),
          })
        )
        return yield* new ExternalFailure({ message: input.failureMessage, service: "email", cause })
      })
    ),
    Effect.as({ usingBrandedDomain: envelope.usingBrandedDomain })
  )
}
