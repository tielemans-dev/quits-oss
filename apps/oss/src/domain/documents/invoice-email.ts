import { parseBuyerSnapshot } from "@quits/contracts/documents"
import { issuedInvoiceSnapshot, issuedSeller } from "./issued-invoice"
import { computeSettlement } from "./settlement"
import { vatRowsByRate } from "./frozen-vat-groups"
import { Effect } from "effect"
import { z } from "zod"
import type { FieldIssue } from "@quits/contracts/agent"
import {
  readDocumentSendingDomainState,
  resolveDocumentEmailEnvelope,
} from "../../lib/document-email-sending"
import { buildInvoiceEmailContent, composeMessage } from "../../lib/email"
import type { PdfAttachment } from "../../lib/documents/pdf-attachment"
import { getEmailDeliveryRuntimeStatus } from "../../lib/email-delivery"
import type { StripeAccountStatus } from "@quits/contracts/payments"
import { getStripePaymentConfigurationState } from "../../lib/payments/stripe"
import { getRuntimeCapabilities } from "../../lib/runtime/extensions"
import { getRuntimeEnv, getRuntimePlatform } from "../../lib/runtime/platform"
import { InvalidState } from "../errors"
import { lineAmounts } from "../../lib/documents/line-amounts"
import { documentVatSummary } from "./vat-summary"

type Decimalish = { toNumber(): number }

/** Keep a stored decimal exact (Prisma.Decimal stringifies losslessly). */
function decimalString(value: Decimalish): string {
  return typeof (value as { toFixed?: unknown }).toFixed === "function" ? String(value) : String(value.toNumber())
}

type OrgEmailSettings = {
  companyName: string | null
  companyEmail: string | null
  locale: string
  timezone: string
  stripePublishableKey: string | null
  stripeSecretKeyEnc: string | null
  stripeWebhookSecretEnc: string | null
  stripeAccountStatus?: StripeAccountStatus | null
} & Parameters<typeof readDocumentSendingDomainState>[0]

export type InvoiceForEmail = {
  id: string
  number: string
  paymentReference?: string | null
  /** Copied from the organization when the draft was created. Required so no caller can drop them. */
  locale: string
  timezone: string
  sellerSnapshot?: unknown
  buyerSnapshot?: unknown
  issuanceSnapshot?: unknown
  supplyDate?: Date | null
  issueDate: Date
  dueDate: Date
  taxRegime?: string
  currency: string
  notes: string | null
  subtotalNet: Decimalish
  totalTax: Decimalish
  amountPaid: Decimalish
  amountCredited: Decimalish
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
      stripeAccountStatus: settings.stripeAccountStatus,
    }).configured,
  }
}

export function recipientEmailIssue(contact: { email: string | null }): FieldIssue | undefined {
  return z.string().email().safeParse(contact.email?.trim() ?? "").success
    ? undefined
    : { code: "missing_recipient", field: "customer.email", params: {} }
}

export function requireRecipientEmail(contact: { email: string | null }) {
  const email = contact.email?.trim() ?? ""
  const issue = recipientEmailIssue(contact)
  return issue
    ? Effect.fail(new InvalidState({ message: "Contact has no email address", code: "missing_recipient", fieldIssues: [issue] }))
    : Effect.succeed(email)
}

/** The invoice email exactly as it will be delivered. */
export function composeInvoiceEmail(input: {
  invoice: InvoiceForEmail
  settings: OrgEmailSettings
  to: string
  publicPaymentUrl: string | null
  /** The stored, issued PDF; never a fresh render. */
  pdf?: PdfAttachment | null
}) {
  const { envelope } = resolveInvoiceEmailContext(input.settings)
  const { invoice } = input
  const frozen = issuedInvoiceSnapshot(invoice.issuanceSnapshot)
  const seller = issuedSeller(invoice.issuanceSnapshot, invoice.sellerSnapshot)
  const buyer = frozen?.buyer ?? parseBuyerSnapshot(invoice.buyerSnapshot)
  // Amounts come from the invoice row, the single source of truth (immutable after issue).
  const settlement = computeSettlement({
    totalGross: decimalString(invoice.totalGross),
    amountPaid: decimalString(invoice.amountPaid),
    amountCredited: decimalString(invoice.amountCredited),
  })
  const vatSummary = documentVatSummary(invoice, frozen ? vatRowsByRate(frozen.vatGroups, frozen.currency) : undefined)
  const content = buildInvoiceEmailContent({
    fromName: envelope.fromName,
    fromEmail: envelope.fromEmail,
    replyTo: envelope.replyTo,
    invoice: {
      ...invoice,
      momsRegistered: seller?.momsRegistered,
      subtotal: invoice.subtotalNet.toNumber(),
      taxAmount: invoice.totalTax.toNumber(),
      balanceDue: settlement.balanceDue.toNumber(),
      total: settlement.totalGross.toNumber(),
      issueDate: frozen?.occurredAt ?? invoice.issueDate,
      supplyDate: frozen ? frozen.supplyDate : invoice.supplyDate?.toISOString().slice(0, 10),
      buyer,
      bankAccount: seller?.bankAccount,
      paymentNote: seller?.paymentNote,
      priceBasis: "net",
      ...vatSummary,
      items: invoice.items.map((item) => {
        const shown = lineAmounts("net", item)
        return {
          description: item.description,
          taxRate: item.taxRate.toNumber(),
          quantity: item.quantity.toNumber(),
          unitPrice: shown.unitPrice.toNumber(),
          total: shown.amount.toNumber(),
        }
      }),
    },
    org: { ...documentEmailOrg(invoice, input.settings),
      // A historic seller snapshot is authoritative even when individual fields are missing.
      ...(seller ? { companyName: seller.companyName, companyEmail: seller.companyEmail, companyAddress: seller.companyAddress, taxIds: seller.taxIds } : { companyName: null, companyEmail: null }),
    },
    contactName: buyer?.name ?? "",
    publicPaymentUrl: input.publicPaymentUrl,
    pdfAttached: Boolean(input.pdf),
  })
  return { message: composeMessage(input.to, content, input.pdf), usingBrandedDomain: envelope.usingBrandedDomain }
}
