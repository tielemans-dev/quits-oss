import type { ComponentType } from "react"

import { parseRequest, type RequestContext } from "../../lib/request-parser"

/** A request the person typed that a card can answer. The card reads `input` for the details. */
export type RequestIntent = { kind: "invoice" | "overdue"; input: string }

/** Says whether `input` reads as a request. Ordinary search is null and stays search. */
export type RequestRecognizer = (input: string) => RequestIntent | null

// Recognising an intent needs no customers or catalogue; the cards match those when they open.
const noContext: RequestContext = { customers: [], catalogItems: [] }

export const recognizeRequest: RequestRecognizer = (input) => {
  const draft = parseRequest(input, noContext)
  return draft ? { kind: draft.intent, input: input.trim() } : null
}

/** The permission a card's confirming click needs: creating an invoice, or sending the rykkere. */
const REQUIRED = { invoice: "invoice:create", overdue: "invoice:send" } as const

/** A request is offered to those who may do what its card would do on the click. */
export function permittedRequest(
  recognize: RequestRecognizer,
  can: (action: (typeof REQUIRED)[RequestIntent["kind"]]) => boolean
): RequestRecognizer {
  return (input) => {
    const intent = recognize(input)
    return intent && can(REQUIRED[intent.kind]) ? intent : null
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
