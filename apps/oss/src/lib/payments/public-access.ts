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

  return loadPublicInvoice({ id: payload.invoiceId, keyVersion: payload.keyVersion })
}

/**
 * An invoice as its public page shows it, once whoever asks is known to be entitled to it. The
 * payment link checks its signature first; the client action page checks its grant, and narrows
 * the lookup to the organization and contact that grant belongs to.
 */
export async function loadPublicInvoice(input: {
  id: string
  keyVersion: number
  organizationId?: string
  contactId?: string
}) {
  const invoice = await prisma.invoice.findFirst({
    where: {
      id: input.id,
      ...(input.organizationId ? { organizationId: input.organizationId } : {}),
      ...(input.contactId ? { contactId: input.contactId } : {}),
      publicPaymentKeyVersion: input.keyVersion,
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
