import { Effect } from "effect"
import { z } from "zod"
import {
  readDocumentSendingDomainState,
  resolveDocumentEmailEnvelope,
} from "../../lib/document-email-sending"
import { sendInvoiceEmail } from "../../lib/email"
import { createEmailDeliveryAttempt, getEmailDeliveryRuntimeStatus } from "../../lib/email-delivery"
import { getStripePaymentConfigurationState } from "../../lib/payments/stripe"
import { getRuntimeCapabilities } from "../../lib/runtime/extensions"
import { prisma } from "../../lib/db"
import { ExternalFailure, InvalidState } from "../errors"
import { Command } from "../services"

type Decimalish = { toNumber(): number }

type OrgEmailSettings = {
  companyName: string | null
  companyEmail: string | null
  locale: string
  timezone: string
  stripePublishableKey: string | null
  stripeSecretKeyEnc: string | null
  stripeWebhookSecretEnc: string | null
} & Parameters<typeof readDocumentSendingDomainState>[0]

export type InvoiceForEmail = {
  id: string
  number: string
  issueDate: Date
  dueDate: Date
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

/** Sender identity, delivery availability, and whether pay links can be issued. */
export function resolveInvoiceEmailContext(settings: OrgEmailSettings) {
  return {
    envelope: resolveDocumentEmailEnvelope({
      orgName: settings.companyName,
      orgBillingEmail: settings.companyEmail,
      sharedFromEmail: process.env.FROM_EMAIL ?? "noreply@yaip.app",
      branded: readDocumentSendingDomainState(settings),
    }),
    emailDelivery: getEmailDeliveryRuntimeStatus({
      managed: getRuntimeCapabilities().emailDelivery.managed,
      resendApiKey: process.env.RESEND_API_KEY,
      fromEmail: process.env.FROM_EMAIL,
    }),
    stripeConfigured: getStripePaymentConfigurationState({
      stripePublishableKey: settings.stripePublishableKey,
      stripeSecretKeyEnc: settings.stripeSecretKeyEnc,
      stripeWebhookSecretEnc: settings.stripeWebhookSecretEnc,
    }).configured,
  }
}

export function requireRecipientEmail(contact: { email: string | null }) {
  const email = contact.email?.trim() ?? ""
  return z.string().email().safeParse(email).success
    ? Effect.succeed(email)
    : Effect.fail(new InvalidState({ message: "Contact has no email address", code: "missing_recipient" }))
}

/**
 * Sends the invoice email. On failure the failed attempt is recorded after the command's
 * transaction rolls back, then the command fails.
 */
export function deliverInvoiceEmail(input: {
  invoice: InvoiceForEmail
  settings: OrgEmailSettings
  to: string
  publicPaymentUrl: string | null
  failureMessage: string
  /** Scope for the provider idempotency key; see `DeliveryOptions.idempotencyScope`. */
  idempotencyScope?: string
}) {
  const { envelope } = resolveInvoiceEmailContext(input.settings)
  const { invoice } = input

  return Effect.tryPromise({
    try: () =>
      sendInvoiceEmail({
        to: input.to,
        fromName: envelope.fromName,
        fromEmail: envelope.fromEmail,
        replyTo: envelope.replyTo,
        invoice: {
          ...invoice,
          subtotal: invoice.subtotalNet.toNumber(),
          taxAmount: invoice.totalTax.toNumber(),
          total: invoice.totalGross.toNumber(),
          items: invoice.items.map((item) => ({
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
        contactName: invoice.contact.name,
        publicPaymentUrl: input.publicPaymentUrl,
      }, { idempotencyScope: input.idempotencyScope }),
    catch: (cause) => cause,
  }).pipe(
    Effect.catchAll((cause) =>
      Effect.gen(function* () {
        const command = yield* Command
        // Recorded after the rollback so the failed attempt survives the command failing.
        command.onRollback(() =>
          prisma.invoice.update({
            where: { id: invoice.id },
            data: createEmailDeliveryAttempt({
              outcome: "failed",
              code: "send_failed",
              message: "Failed to send invoice email.",
            }),
          })
        )
        return yield* new ExternalFailure({ message: input.failureMessage, service: "email", cause })
      })
    ),
    Effect.as({ usingBrandedDomain: envelope.usingBrandedDomain })
  )
}
