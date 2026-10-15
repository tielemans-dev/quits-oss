import { computeSettlement } from "../../domain/documents/settlement"
import { prisma } from "../db"
import { publicPresentationSettingsSelect } from "../documents/public-presentation"
import {
  assessCardCheckout,
  resolveStripeCheckoutTarget,
  type StripeCheckoutTarget,
  type StripePaymentConfigurationSnapshot,
} from "./stripe"
import { appLogger } from "../observability"
import {
  getInvoicePaymentState,
  type InvoicePaymentState,
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
  const checkoutTarget = await resolveCardCheckoutTarget({
    organizationId: invoice.organizationId,
    settings,
    paymentState,
    balanceDue,
    currency: invoice.currency,
  })
  return { invoice, paymentState, stripeEnabled: Boolean(checkoutTarget), checkoutTarget }
}

/** The card checkout target `/pay` would offer for this balance, or null when it offers bank transfer only. */
export async function resolveCardCheckoutTarget(input: {
  organizationId: string
  settings: StripePaymentConfigurationSnapshot | null | undefined
  paymentState: InvoicePaymentState
  balanceDue: { greaterThan: (value: number) => boolean; toNumber: () => number }
  currency: string
}): Promise<StripeCheckoutTarget | null> {
  const cardEligible = input.paymentState === "unpaid" && input.balanceDue.greaterThan(0) && assessCardCheckout({
    configuration: input.settings,
    amount: input.balanceDue.toNumber(),
    currency: input.currency,
  }).ready
  if (!cardEligible) return null
  try {
    return await resolveStripeCheckoutTarget(
      { organizationId: input.organizationId },
      { connectReady: input.settings?.stripeAccountStatus === "active" },
    )
  } catch {
    appLogger.child("payments").error("public_invoice.checkout_target_unavailable", { organizationId: input.organizationId })
    return null
  }
}
