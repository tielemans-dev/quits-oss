import type { StripeAccountStatus } from "@quits/contracts/payments"
import { computeSettlement } from "../../domain/documents/settlement"
import { prisma } from "../db"
import { publicPresentationSettingsSelect } from "../documents/public-presentation"
import { appLogger } from "../observability"
import { assessCardCheckout, resolveStripeCheckoutTarget } from "./stripe"
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
  const session = {
    invoice,
    paymentState,
    stripeEnabled: paymentState === "unpaid" && balanceDue.greaterThan(0) && assessCardCheckout({
      configuration: {
        stripePublishableKey: settings?.stripePublishableKey ?? null,
        stripeSecretKeyEnc: settings?.stripeSecretKeyEnc ?? null,
        stripeWebhookSecretEnc: settings?.stripeWebhookSecretEnc ?? null,
        stripeAccountStatus: settings?.stripeAccountStatus,
      },
      amount: balanceDue.toNumber(),
      currency: invoice.currency,
    }).ready,
  }
  // Card checkout is optional. A throwing extension or a BYOK secret that can no longer
  // be decrypted must not hide the invoice, its PDF, or its bank transfer details.
  let stripeEnabled = false
  if (session.stripeEnabled) {
    try {
      stripeEnabled = Boolean(await resolvePublicInvoiceCheckoutTarget(session))
    } catch (error) {
      appLogger.child("payments").error("public_invoice.checkout_target_failed", {
        invoiceId: invoice.id,
        organizationId: invoice.organizationId,
        error,
      })
    }
  }
  return { ...session, stripeEnabled }
}

/** The page and checkout must agree on the target that can actually take this payment. */
export async function resolvePublicInvoiceCheckoutTarget(session: {
  stripeEnabled: boolean
  invoice: {
    organizationId: string
    organization: { settings: { stripeAccountStatus?: StripeAccountStatus | null } | null }
  }
}) {
  if (!session.stripeEnabled) return null
  return resolveStripeCheckoutTarget(
    { organizationId: session.invoice.organizationId },
    { connectReady: session.invoice.organization.settings?.stripeAccountStatus === "active" },
  )
}
