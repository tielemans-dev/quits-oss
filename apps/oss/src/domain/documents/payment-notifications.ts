import { Effect } from "effect"
import type { Invoice, Payment } from "../../../generated/prisma/client"
import { composeMessage } from "../../lib/email"
import { buildPaymentReceivedEmailContent } from "../../lib/emails/payment-received-email"
import { Prisma } from "../../../generated/prisma/client"
import { deliveryKey, registerDeliveryCompletion, enqueueEmailDelivery } from "../delivery/outbox"
import { isValidRecipient } from "../commands/reminders"
import { Command, Db } from "../services"
import { documentEmailOrg, resolveInvoiceEmailContext } from "./invoice-email"
import { issuedSeller } from "./issued-invoice"
import { issuedNumber } from "./numbering"

const PAYMENT_NOTIFICATION = "payment.notification"

export const PAYMENT_VOIDED_MESSAGE = "The payment was voided or undone, or the invoice is no longer paid in full, before the email went out"

/**
 * Notifications settle only their job; the payment and the invoice are already recorded. A
 * payment undone or voided before the provider is contacted is no longer news, so it withdraws.
 */
registerDeliveryCompletion(PAYMENT_NOTIFICATION, {
  pending: async () => true,
  withdrawalReason: async (db, target) => {
    const payment = await db.payment.findUnique({
      where: { id: target.paymentId },
      select: { voidedAt: true, invoice: { select: { paymentStatus: true } } },
    })
    return !payment || payment.voidedAt || payment.invoice.paymentStatus !== "paid" ? PAYMENT_VOIDED_MESSAGE : null
  },
  delivered: async () => [],
  failed: async () => [],
})

const AUDIENCES = ["client", "seller"] as const

/** Names exactly one payment's email to one audience. */
const idempotencyKey = (paymentId: string, audience: (typeof AUDIENCES)[number]) => `payment-received-${paymentId}-${audience}`

/**
 * Withdraws a payment's notifications that no provider request has started for. Call it in the
 * command that voids or undoes the payment, so it serializes with a worker on the job rows: a
 * worker that already passed `withdrawalReason` loses its claim and fails its next write, before
 * it contacts the provider. A request already started keeps its own outcome, because the provider
 * may have it; that is the only window left open.
 */
export async function withdrawPaymentNotifications(db: Prisma.TransactionClient, paymentId: string) {
  await db.job.updateMany({
    where: {
      dedupeKey: { in: AUDIENCES.map((audience) => deliveryKey(idempotencyKey(paymentId, audience))) },
      result: { equals: Prisma.DbNull },
      payload: { path: ["requests"], equals: 0 },
    },
    data: { status: "done", claimToken: null, result: { outcome: "withdrawn", message: PAYMENT_VOIDED_MESSAGE } },
  })
}

/**
 * Queues the emails for an invoice that this payment just paid in full: a confirmation to the
 * customer and a notice to the seller. Call it in the payment's own command, so the emails are
 * queued in the same transaction and a redelivered webhook, which records no second payment,
 * queues nothing. Each recipient has one key per payment, so a retry never sends a second copy.
 *
 * Only a card payment confirmed by the Stripe webhook (recorded with the webhook's source and
 * checkout session) is confirmed to the customer. A payment
 * the seller records by hand is something the seller already knows about and may still undo or
 * correct, so only the seller's inbox is told about it. A recipient is skipped when it has no
 * valid address or when this installation cannot send email.
 */
export const queuePaymentReceivedEmails = (input: { invoice: Invoice; payment: Payment }) =>
  Effect.gen(function* () {
    const db = yield* Db
    const { organizationId } = yield* Command
    const { invoice, payment } = input

    const [settings, contact] = yield* Effect.promise(() =>
      Promise.all([
        db.orgSettings.findUnique({ where: { organizationId } }),
        db.contact.findUniqueOrThrow({ where: { id: invoice.contactId }, select: { name: true, email: true } }),
      ])
    )
    if (!settings) return
    const { envelope, emailDelivery } = resolveInvoiceEmailContext(settings)
    if (!emailDelivery.available) return

    const number = issuedNumber(invoice)
    const documentOrg = documentEmailOrg(invoice, settings)
    const sellerName = issuedSeller(invoice.issuanceSnapshot, invoice.sellerSnapshot)?.companyName ?? settings.companyName ?? envelope.fromName
    const stored = { amount: payment.amount.toNumber(), currency: payment.currency, paidAt: payment.paidAt }
    const sender = { fromName: envelope.fromName, fromEmail: envelope.fromEmail }

    const queue = (audience: "client" | "seller", to: string) =>
      enqueueEmailDelivery({
        message: composeMessage(
          to,
          buildPaymentReceivedEmailContent({
            audience,
            ...sender,
            // The customer reads it in the invoice's language; the seller in the organization's.
            ...(audience === "client" ? { replyTo: envelope.replyTo, org: documentOrg } : { org: settings }),
            invoice: { number },
            payment: stored,
            sellerName,
            contactName: contact.name,
            sellerEmail: settings.companyEmail,
          })
        ),
        idempotencyKey: idempotencyKey(payment.id, audience),
        completion: { kind: PAYMENT_NOTIFICATION, target: { invoiceId: invoice.id, paymentId: payment.id } },
      })

    const customerEmail = contact.email?.trim()
    // Provenance, not the method a caller claimed: only the webhook command records this source.
    const confirmedByStripe = payment.source === "stripe" && payment.stripeCheckoutSessionId !== null
    if (confirmedByStripe && customerEmail && isValidRecipient(customerEmail)) {
      yield* queue("client", customerEmail)
    }
    const sellerEmail = settings.companyEmail?.trim()
    if (sellerEmail && isValidRecipient(sellerEmail)) {
      yield* queue("seller", sellerEmail)
    }
  })
