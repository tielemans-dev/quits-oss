import { prisma } from "../db"
import { publicPresentationSettingsSelect } from "../documents/public-presentation"
import { getStripePaymentConfigurationState } from "./stripe"
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
            },
          },
        },
      },
    },
  })

  if (!invoice) {
    return null
  }

  const stripeState = getStripePaymentConfigurationState({
    stripePublishableKey: invoice.organization.settings?.stripePublishableKey ?? null,
    stripeSecretKeyEnc: invoice.organization.settings?.stripeSecretKeyEnc ?? null,
    stripeWebhookSecretEnc: invoice.organization.settings?.stripeWebhookSecretEnc ?? null,
  })

  return {
    invoice,
    paymentState: getInvoicePaymentState(invoice),
    stripeEnabled: stripeState.configured,
  }
}
