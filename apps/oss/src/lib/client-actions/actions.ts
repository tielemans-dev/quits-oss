import type { ClientActionRefusal, ClientActionRequest } from "@quits/contracts/client-actions"
import { executeCommand } from "../../domain/execute"
import { recordClientLinkAction } from "../../domain/commands/client-links"
import { signAgreementPublicToken, getAgreementPublicSecret } from "../agreements/tokens"
import { decidePublicAgreementByToken, decidePublicDeliverableByToken } from "../agreements/public-access"
import { getPublicInvoicePaymentSecret, signInvoicePaymentToken } from "../payments/public"
import { resolvePublicInvoiceCheckout } from "../payments/public-checkout"
import { appLogger } from "../observability"
import { findGrant, type ActiveClientActionLink } from "./access"
import { loadGrantedAgreement, loadGrantedDeliverable, loadGrantedInvoice } from "./page"
import { clientActionUrl } from "./tokens"
import { deliveryReviewExpiresAt, deliveryReviewState } from "./delivery"

const logger = appLogger.child("client-actions")

export type ClientActionOutcome =
  | { status: "ok"; checkoutUrl: string | null }
  | { status: ClientActionRefusal }

const refuse = (status: ClientActionRefusal): ClientActionOutcome => ({ status })

function refusalFrom(error: unknown): ClientActionRefusal {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined
  if (code === "retry_later") return "retry_later"
  if (code === "already_decided") return "already_decided"
  // The existing commands refuse a link whose revision moved on as "invalid".
  if (code === "invalid") return "changed"
  return "unavailable"
}

/**
 * Carries out one action of a visitor of the client action page.
 *
 * The link's grants decide whether the visitor may ask; the existing public commands decide what
 * happens. Each command is handed an internal token naming the revision the visitor saw, never the
 * record's current one, so a record that moved on since is refused by the command exactly as an
 * old emailed link is. Those tokens are minted here, used once and never sent to the browser.
 */
export async function performClientAction(
  link: ActiveClientActionLink,
  request: ClientActionRequest,
  context: {
    token: string
    verified: boolean
    evidence?: { ip?: string | null; userAgent?: string | null }
    now?: Date
  },
): Promise<ClientActionOutcome> {
  const now = context.now ?? new Date()
  const outcome = await dispatch(link, request, context, now)
  if (outcome.status === "ok") await audit(link, request, now)
  return outcome
}

async function dispatch(
  link: ActiveClientActionLink,
  request: ClientActionRequest,
  context: { token: string; verified: boolean; evidence?: { ip?: string | null; userAgent?: string | null } },
  now: Date,
): Promise<ClientActionOutcome> {
  // A signature needs a verified recipient on every link; other approvals when the link asks for it.
  const verificationMissing = (kind: "agreement" | "deliverable") =>
    !context.verified && (kind === "agreement" || link.verification === "email_code")

  switch (request.type) {
    case "agreement.accept":
    case "agreement.decline": {
      const grant = findGrant(link, "agreement", request.agreementId, "approve")
      if (!grant) return refuse("not_permitted")
      if (verificationMissing("agreement")) return refuse("verification_required")
      const loaded = await loadGrantedAgreement(link, grant)
      if (loaded.state !== "ready") return refuse("unavailable")
      const { agreement } = loaded
      if (agreement.offerRevision !== request.offerRevision) return refuse("changed")
      if (!agreement.expiresAt) return refuse("unavailable")
      const token = signAgreementPublicToken(
        {
          agreementId: agreement.id,
          keyVersion: agreement.publicAccessKeyVersion,
          scope: "decide",
          exp: agreement.expiresAt.toISOString(),
          offerRevision: request.offerRevision,
        },
        getAgreementPublicSecret(),
      )
      try {
        await decidePublicAgreementByToken(
          token,
          request.type === "agreement.accept"
            ? { decision: "accept", acceptedByName: request.acceptedByName, confirmed: request.confirmed }
            : { decision: "decline", reason: request.reason },
          context.evidence,
          now,
        )
        return { status: "ok", checkoutUrl: null }
      } catch (error) {
        return refuse(refusalFrom(error))
      }
    }
    case "deliverable.accept":
    case "deliverable.request_changes": {
      const grant = findGrant(link, "deliverable", request.deliverableId, "approve")
      if (!grant) return refuse("not_permitted")
      if (verificationMissing("deliverable")) return refuse("verification_required")
      const loaded = await loadGrantedDeliverable(link, grant)
      if (loaded.state !== "ready") return refuse("unavailable")
      const { agreement, line } = loaded
      if (line.deliveryRevision !== request.deliveryRevision) return refuse("changed")
      const expiresAt = deliveryReviewExpiresAt(line.deliveredAt)
      if (!expiresAt || deliveryReviewState(line, now) === "expired") return refuse("unavailable")
      const token = signAgreementPublicToken(
        {
          agreementId: agreement.id,
          keyVersion: agreement.publicAccessKeyVersion,
          scope: "sign_off",
          deliverableId: line.id,
          deliveryRevision: request.deliveryRevision,
          exp: expiresAt.toISOString(),
        },
        getAgreementPublicSecret(),
      )
      try {
        await decidePublicDeliverableByToken(
          token,
          request.type === "deliverable.accept"
            ? { decision: "accept", confirmed: request.confirmed }
            : { decision: "request_changes", note: request.note },
          now,
        )
        return { status: "ok", checkoutUrl: null }
      } catch (error) {
        return refuse(refusalFrom(error))
      }
    }
    case "invoice.pay": {
      const grant = findGrant(link, "invoice", request.invoiceId, "pay")
      if (!grant) return refuse("not_permitted")
      const loaded = await loadGrantedInvoice(link, grant)
      if (loaded.state !== "ready") return refuse("unavailable")
      const token = signInvoicePaymentToken(
        { invoiceId: loaded.invoice.id, keyVersion: grant.keyVersion, scope: "invoice_payment" },
        getPublicInvoicePaymentSecret(),
      )
      const result = await resolvePublicInvoiceCheckout(token, {
        returnUrl: `${clientActionUrl(context.token)}?item=invoice:${encodeURIComponent(loaded.invoice.id)}`,
      })
      if (result.status === "redirect" && result.url) return { status: "ok", checkoutUrl: result.url }
      // Paid in the meantime: nothing to collect, and the refreshed page says so.
      if (result.status === "paid") return { status: "ok", checkoutUrl: null }
      return refuse("unavailable")
    }
  }
}

async function audit(link: ActiveClientActionLink, request: ClientActionRequest, now: Date) {
  const target =
    request.type === "agreement.accept" || request.type === "agreement.decline"
      ? ({ recordKind: "agreement", recordId: request.agreementId } as const)
      : request.type === "invoice.pay"
        ? ({ recordKind: "invoice", recordId: request.invoiceId } as const)
        : ({ recordKind: "deliverable", recordId: request.deliverableId } as const)
  const action =
    request.type === "invoice.pay" ? "start_payment" : (request.type.split(".")[1] as "accept" | "decline" | "request_changes")
  try {
    await executeCommand(
      recordClientLinkAction,
      { linkId: link.id, ...target, action },
      {
        actor: {
          kind: "system",
          reason: "customer_link",
          organizationId: link.organizationId,
          label: `Client action page (${link.recipientName})`,
        },
        now,
      },
    )
  } catch (error) {
    // The action already happened; a missing activity entry must not turn it into an error.
    logger.error("client_link.audit_failed", { linkId: link.id, error })
  }
}
