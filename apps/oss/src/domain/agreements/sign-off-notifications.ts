import { Effect } from "effect"
import type { Agreement, Deliverable } from "../../../generated/prisma/client"
import { mintAgreementLink, mintDeliverableSignOffLink } from "../../lib/agreements/tokens"
import { Command } from "../services"
import { loadDocumentContext } from "../documents/context"
import { resolveQuoteEmailContext } from "../documents/quote-email"
import { composeDeliverableEmail } from "../documents/deliverable-email"
import { enqueueEmailDelivery } from "../delivery/outbox"

/** Notifications settle only their job, never document markers or fulfillment state. */
export const notifyDeliverable = (agreement: Agreement, line: Deliverable, kind: "delivered" | "accepted" | "changes_requested") =>
  Effect.gen(function* () {
    const command = yield* Command
    const { settings } = yield* loadDocumentContext
    const link = kind === "delivered" ? mintDeliverableSignOffLink(agreement, line) : mintAgreementLink(agreement, "read", command.now)
    const recipient = (kind === "delivered" ? agreement.issuedToEmail : settings.companyEmail)?.trim()
    if (!recipient || !resolveQuoteEmailContext(settings).emailDelivery.available) return { link, deliveryKey: null }
    const { deliveryKey } = yield* enqueueEmailDelivery({
      message: composeDeliverableEmail({ settings, locale: agreement.locale, number: agreement.number, title: line.title, recipient, url: link.url, kind, note: line.changeRequestNote }),
      idempotencyKey: `agreement-${agreement.id}-deliverable-${line.id}-${kind === "delivered" ? "delivered" : "signoff"}-${line.deliveryRevision}`,
      completion: { kind: "agreement.notification", target: { agreementId: agreement.id } },
    })
    return { link, deliveryKey }
  })
