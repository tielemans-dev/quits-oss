import { computeSettlement } from "../../domain/documents/settlement"
import { prisma } from "../db"
import { publicPresentationSettingsSelect } from "../documents/public-presentation"
import { assessCardCheckout, resolveStripeCheckoutTarget, type StripeCheckoutTarget } from "./stripe"
import { appLogger } from "../observability"
import {
  getInvoicePaymentState,
  verifyInvoicePaymentToken,
} from "./public"

export async function loadPublicInvoiceByToken(token: string, secret: string) {
  const payload = verifyInvoicePaymentToken(token, secret)
  if (!payload) {
    return null
  }

  const invoice = await prisma.invoice.findFirst({
    where: {
      id: payload.invoiceId,
      publicPaymentKeyVersion: payload.keyVersion,
      publicPaymentIssuedAt: {
        not: null,
      },
      // A link already emailed keeps working once the invoice is paid or credited in full; the
      // page then shows it as settled instead of offering a payment.
      status: {
        in: ["sent", "overdue", "paid", "credited"],
      },
    },
    include: {
      contact: {
        select: {
          name: true,
          email: true,
          company: true,
        },
      },
      items: {
        orderBy: { sortOrder: "asc" },
      },
      organization: {
        select: {
          settings: {
            select: {
              // Language, timezone, name and logo of the seller, for presenting the page.
              ...publicPresentationSettingsSelect,
              stripePublishableKey: true,
              stripeSecretKeyEnc: true,
              stripeWebhookSecretEnc: true,
              stripeAccountStatus: true,
            },
          },
        },
      },
    },
  })

  if (!invoice) {
    return null
  }

  const settings = invoice.organization.settings
  const balanceDue = computeSettlement(invoice).balanceDue

  const paymentState = getInvoicePaymentState(invoice)
  const cardEligible = paymentState === "unpaid" && balanceDue.greaterThan(0) && assessCardCheckout({
    configuration: settings,
    amount: balanceDue.toNumber(),
    currency: invoice.currency,
  }).ready
  let checkoutTarget: StripeCheckoutTarget | null = null
  if (cardEligible) {
    try {
      checkoutTarget = await resolveStripeCheckoutTarget(
        { organizationId: invoice.organizationId },
        { connectReady: settings?.stripeAccountStatus === "active" },
      )
    } catch {
      appLogger.child("payments").error("public_invoice.checkout_target_unavailable", { invoiceId: invoice.id })
    }
  }
  return { invoice, paymentState, stripeEnabled: Boolean(checkoutTarget), checkoutTarget }
}
