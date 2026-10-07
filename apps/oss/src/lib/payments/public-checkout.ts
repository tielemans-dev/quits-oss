import { buildAbsoluteUrl, resolveAppOrigin } from "@quits/shared/http"
import { computeSettlement } from "../../domain/documents/settlement"
import { prisma } from "../db"
import { appLogger } from "../observability"
import { loadPublicInvoiceByToken } from "./public-access"
import { getPublicInvoicePaymentSecret } from "./public"
import { createStripeInvoiceCheckoutSession, getStripePaymentCredentials } from "./stripe"
import { currencyFractionDigits, isExactInCurrency } from "./stripe-amounts"
import { readProductEnv } from "@quits/shared/runtimeEnv"

const paymentsLogger = appLogger.child("payments")

export async function resolvePublicInvoiceCheckout(token: string) {
  const session = await loadPublicInvoiceByToken(token, getPublicInvoicePaymentSecret())
  if (!session) {
    paymentsLogger.warn("invoice.checkout.invalid", {
      tokenPresent: token.length > 0,
    })
    return { url: null, status: "invalid" } as const
  }

  // Customers pay what they still owe, not the invoice total: earlier partial payments and
  // credit notes reduce the checkout amount.
  const { balanceDue } = computeSettlement(session.invoice)

  if (session.paymentState === "paid" || balanceDue.isZero()) {
    paymentsLogger.info("invoice.checkout.already_paid", {
      invoiceId: session.invoice.id,
      organizationId: session.invoice.organizationId,
    })
    return { url: null, status: "paid" } as const
  }

  // Stripe charges whole minor units. Rounding a balance such as 100.49 JPY would leave an
  // uncollectible remainder or overcharge the customer, so refuse instead.
  if (!isExactInCurrency(balanceDue.toNumber(), session.invoice.currency)) {
    paymentsLogger.warn("invoice.checkout.unavailable", {
      invoiceId: session.invoice.id,
      organizationId: session.invoice.organizationId,
      reason: "balance_not_representable_in_currency",
      currency: session.invoice.currency,
      currencyFractionDigits: currencyFractionDigits(session.invoice.currency),
      balanceDue: balanceDue.toFixed(),
    })
    return { url: null, status: "unavailable" } as const
  }

  const settings = await prisma.orgSettings.findUnique({
    where: { organizationId: session.invoice.organizationId },
    select: {
      stripePublishableKey: true,
      stripeSecretKeyEnc: true,
      stripeWebhookSecretEnc: true,
    },
  })

  const credentials = getStripePaymentCredentials({
    stripePublishableKey: settings?.stripePublishableKey ?? null,
    stripeSecretKeyEnc: settings?.stripeSecretKeyEnc ?? null,
    stripeWebhookSecretEnc: settings?.stripeWebhookSecretEnc ?? null,
  })

  if (!credentials) {
    paymentsLogger.warn("invoice.checkout.unavailable", {
      invoiceId: session.invoice.id,
      organizationId: session.invoice.organizationId,
      reason: "stripe_not_configured",
    })
    return { url: null, status: "unavailable" } as const
  }

  const publicUrl = buildAbsoluteUrl(
    resolveAppOrigin(
      [
        readProductEnv(process.env, "APP_ORIGIN"),
        process.env.BETTER_AUTH_URL,
        "http://localhost:3000",
      ],
      "http://localhost:3000"
    ),
    `/pay/${encodeURIComponent(token)}`
  )

  const checkoutSession = await createStripeInvoiceCheckoutSession({
    credentials,
    invoice: session.invoice,
    amountDue: balanceDue.toNumber(),
    successUrl: publicUrl,
    cancelUrl: publicUrl,
  })

  await prisma.invoice.update({
    where: { id: session.invoice.id },
    data: {
      stripeCheckoutSessionId: checkoutSession.id,
    },
  })

  paymentsLogger.info("invoice.checkout.redirect", {
    invoiceId: session.invoice.id,
    organizationId: session.invoice.organizationId,
    checkoutSessionId: checkoutSession.id,
    amountDue: balanceDue.toNumber(),
  })

  return { url: checkoutSession.url, status: "redirect" } as const
}
