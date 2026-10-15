import { computeSettlement } from "../../domain/documents/settlement"
import { prisma } from "../db"
import { publicPresentationSettingsSelect } from "../documents/public-presentation"
import { assessCardCheckout } from "./stripe"
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

  return {
    invoice,
    paymentState: getInvoicePaymentState(invoice),
    stripeEnabled: assessCardCheckout({
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
}
