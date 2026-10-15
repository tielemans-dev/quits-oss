import type { ComponentType } from "react"

import { parsePaymentRequest } from "../../lib/payments/payment-match"
import { parseRequest, type RequestContext, type RequestDraft } from "../../lib/request-parser"

/** A request the person typed that a card can answer. The card reads `input` for the details. */
export type RequestIntent = { kind: "invoice" | "overdue" | "customer" | "payment" | "creditNote" | "repeat" | "vat"; input: string; suggested?: RequestDraft }

/** Says whether `input` reads as a request. Ordinary search is null and stays search. */
export type RequestRecognizer = (input: string, suggested?: RequestDraft) => RequestIntent | null

// Recognising an intent needs no customers or catalogue; the cards match those when they open.
const noContext: RequestContext = { customers: [], catalogItems: [] }

export const recognizeRequest: RequestRecognizer = (input, suggested) => {
  if (/^\s*(?:vis\s+)?moms(?:oversigt|en)?\s*[?!.]?\s*$/iu.test(input)) return { kind: "vat", input: input.trim() }
  if (suggested) return { kind: suggested.intent, input, suggested }
  if (/^\s*(?:\d{8}|(?:ny\s+kunde|cvr)\b.*)\s*$/iu.test(input)) return { kind: "customer", input: input.trim() }
  if (/^\s*kreditnota\s+[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*\s*$/iu.test(input)) return { kind: "creditNote", input: input.trim() }
  const draft = parseRequest(input, noContext)
  if (draft) return { kind: draft.intent, input: input.trim() }
  return parsePaymentRequest(input) ? { kind: "payment", input: input.trim() } : null
}

/** The permission each card's confirming click needs. */
const REQUIRED = { invoice: "invoice:create", repeat: "invoice:create", overdue: "invoice:send", customer: "contact:create", payment: "payment:create", creditNote: "creditNote:create", vat: "export:read" } as const

/** A request is offered to those who may do what its card would do on the click. */
export function permittedRequest(
  recognize: RequestRecognizer,
  can: (action: (typeof REQUIRED)[RequestIntent["kind"]] | "contact:read") => boolean
): RequestRecognizer {
  return (input, suggested) => {
    const intent = recognize(input, suggested)
    return intent && can(REQUIRED[intent.kind]) && (intent.kind !== "customer" || (can("invoice:create") && can("contact:read"))) ? intent : null
  }
}

export type RequestCardProps = {
  intent: RequestIntent
  /** Dismisses the card and returns to where the request was typed. */
  onDismiss: () => void
}

/** Cards that fill the slot, by intent. Without one the slot shows its plain summary. */
const cards = new Map<RequestIntent["kind"], ComponentType<RequestCardProps>>()

export function registerRequestCard(kind: RequestIntent["kind"], card: ComponentType<RequestCardProps>): () => void {
  cards.set(kind, card)
  return () => {
    if (cards.get(kind) === card) cards.delete(kind)
  }
}

export const requestCardFor = (kind: RequestIntent["kind"]) => cards.get(kind)
