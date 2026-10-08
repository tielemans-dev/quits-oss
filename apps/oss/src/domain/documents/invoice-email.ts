import { Effect } from "effect"
import { z } from "zod"
import {
  readDocumentSendingDomainState,
  resolveDocumentEmailEnvelope,
} from "../../lib/document-email-sending"
import { buildInvoiceEmailContent, composeMessage } from "../../lib/email"
import { getEmailDeliveryRuntimeStatus } from "../../lib/email-delivery"
import { getStripePaymentConfigurationState } from "../../lib/payments/stripe"
import { getRuntimeCapabilities } from "../../lib/runtime/extensions"
import { getRuntimeEnv, getRuntimePlatform } from "../../lib/runtime/platform"
import { InvalidState } from "../errors"
import { lineAmounts, priceBasis } from "../../lib/documents/line-amounts"
import { documentVatSummary } from "./vat-summary"

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
  /** Copied from the organization when the draft was created. Required so no caller can drop them. */
  locale: string
  timezone: string
  issueDate: Date
  dueDate: Date
  currency: string
  notes: string | null
  subtotalNet: Decimalish
  totalTax: Decimalish
  totalGross: Decimalish
  pricesIncludeTax: boolean
  contact: { name: string; email: string | null }
  items: Array<{
    description: string
    quantity: Decimalish
    unitPriceNet: Decimalish
    unitPriceGross: Decimalish
    lineNet: Decimalish
    lineTax: Decimalish
    lineGross: Decimalish
    taxRate: Decimalish
    vatTreatment: string
    vatReasonCode: string | null
    vatCountry: string | null
    vatRateInput: string | null
  }>
}

/**
 * The language and timezone of an email about one document: the ones the document was created
 * with, so a later change to the organization's settings does not change what its customer is
 * sent. Only a document whose own are empty (legacy rows) falls back to the organization's.
 */
export function documentEmailOrg(
  document: { locale: string; timezone: string },
  settings: Pick<OrgEmailSettings, "companyName" | "companyEmail" | "locale" | "timezone">,
) {
  return {
    companyName: settings.companyName,
    companyEmail: settings.companyEmail,
    locale: document.locale || settings.locale,
    timezone: document.timezone || settings.timezone,
  }
}

/** Sender identity, delivery availability, and whether pay links can be issued. */
export function resolveInvoiceEmailContext(settings: OrgEmailSettings) {
  const environment = getRuntimeEnv()
  return {
    envelope: resolveDocumentEmailEnvelope({
      orgName: settings.companyName,
      orgBillingEmail: settings.companyEmail,
      sharedFromEmail: environment.FROM_EMAIL ?? "noreply@yaip.app",
      branded: readDocumentSendingDomainState(settings),
    }),
    emailDelivery: getEmailDeliveryRuntimeStatus({
      managed: getRuntimeCapabilities().emailDelivery.managed,
      resendApiKey: environment.RESEND_API_KEY,
      fromEmail: environment.FROM_EMAIL,
      emailProvider: environment.EMAIL_PROVIDER,
      smtp: environment,
      runtimeKind: getRuntimePlatform().getRuntimeKind(),
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

/** The invoice email exactly as it will be delivered. */
export function composeInvoiceEmail(input: {
  invoice: InvoiceForEmail
  settings: OrgEmailSettings
  to: string
  publicPaymentUrl: string | null
}) {
  const { envelope } = resolveInvoiceEmailContext(input.settings)
  const { invoice } = input
  const vatSummary = documentVatSummary(invoice)
  const content = buildInvoiceEmailContent({
    fromName: envelope.fromName,
    fromEmail: envelope.fromEmail,
    replyTo: envelope.replyTo,
    invoice: {
      ...invoice,
      subtotal: invoice.subtotalNet.toNumber(),
      taxAmount: invoice.totalTax.toNumber(),
      total: invoice.totalGross.toNumber(),
      priceBasis: priceBasis(invoice.pricesIncludeTax),
      ...vatSummary,
      items: invoice.items.map((item) => {
        const shown = lineAmounts(priceBasis(invoice.pricesIncludeTax), item)
        return {
          description: item.description,
          quantity: item.quantity.toNumber(),
          unitPrice: shown.unitPrice.toNumber(),
          total: shown.amount.toNumber(),
        }
      }),
    },
    org: documentEmailOrg(invoice, input.settings),
    contactName: invoice.contact.name,
    publicPaymentUrl: input.publicPaymentUrl,
  })
  return { message: composeMessage(input.to, content), usingBrandedDomain: envelope.usingBrandedDomain }
}
