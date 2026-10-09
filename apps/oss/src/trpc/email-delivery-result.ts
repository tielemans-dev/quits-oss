import { TRPCError } from "@trpc/server"
import { DomainRefusal } from "./outcome"
import { emailProviderFailureMessage } from "../domain/delivery/provider-failure"
import { readDeliveryResult } from "../domain/delivery/outbox"

/**
 * The outcome of one queued email for the UI, read from that delivery's own record rather than
 * from the document, which a later attempt may already have changed. The delivery is attempted
 * right after the command commits, so it has usually settled by now. A refused or withdrawn email
 * throws, with the reason; an uncertain one is still being retried (`pending`) or was given up
 * without confirmation (`unconfirmed`).
 */
export async function readEmailDelivery(deliveryKey: string, noun: string) {
  const result = await readDeliveryResult(deliveryKey)
  if (result.outcome === "rejected") {
    const code = result.code ?? "email_provider_refused"
    const message = emailProviderFailureMessage(code)
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message,
      cause: new DomainRefusal({ tag: "ExternalFailure", code, message }),
    })
  }
  if (result.outcome === "withdrawn") {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: result.message ?? `The ${noun} email was not sent.` })
  }
  return result.outcome === "delivered" ? "sent" : result.outcome
}

/** A send command's result, updated with how its email delivery went. */
export async function settleEmailResult<
  Result extends { emailSent: boolean; emailPending: boolean; deliveryKey?: string },
  Row extends object,
>(result: Result, noun: string, reload: () => Promise<Row>) {
  if (!result.deliveryKey) {
    return { ...result, emailUnconfirmed: false }
  }
  const delivery = await readEmailDelivery(result.deliveryKey, noun)
  return {
    ...result,
    ...(await reload()),
    emailSent: delivery === "sent",
    emailPending: delivery === "pending",
    emailUnconfirmed: delivery === "unconfirmed",
  }
}
