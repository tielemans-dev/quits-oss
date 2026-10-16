import { z } from "zod"

/**
 * A decision model (TypeSafe's Jev) reading what was typed into the palette, for text the parser
 * cannot read: "hvem skylder mig penge" is a request for overdue invoices. It only chooses a kind
 * of request and says how sure it is; it writes nothing. Customers are found in the app, so only
 * what was typed is sent. Off unless the operator sets the key.
 */
export const DECISION_KINDS = ["overdue", "invoice", "creditNote", "customer", "payment", "vat", "search"] as const
export type RequestDecision = {
  kind: (typeof DECISION_KINDS)[number]
  /** The model's probability for `kind`, from 0 to 1. */
  probability: number
}

const ENDPOINT = "https://api.typesafe.ai/v1/systemone"
/** It answers in about 250ms; past this the person has typed on, and the answer is of no use. */
const TIMEOUT_MS = 2000
/** Calls per organization a minute, in this instance: typing asks on nearly every key, a script asks far more. */
const PER_MINUTE = 300
const recent = new Map<string, number[]>()

/** Whether `organizationId` may make another call now; counts the call when it may. */
export function allowDecision(organizationId: string, now = Date.now()): boolean {
  const calls = (recent.get(organizationId) ?? []).filter((at) => now - at < 60_000)
  if (calls.length >= PER_MINUTE) return false
  calls.push(now)
  recent.set(organizationId, calls)
  return true
}

const choiceSchema = z.object({ choice: z.string(), probabilities: z.record(z.string(), z.number()) })
const responseSchema = z.object({ answers: z.object({ intent: choiceSchema }) })

const QUESTIONS = {
  intent: {
    type: "choice",
    instructions: "This is what a person typed into the search field of a Danish invoicing app, possibly unfinished. What do they most likely want?",
    criteria: {
      overdue: "See the invoices that are overdue or unpaid, or send reminders (rykkere) for them",
      invoice: "Create and send a new invoice (faktura) to a customer",
      creditNote: "Credit an existing invoice: make a credit note (kreditnota), refund or cancel an invoice",
      customer: "Create a new customer that does not exist yet, for instance from a CVR number. Not for finding or listing existing customers",
      payment: "Record that a payment was received for an invoice",
      vat: "See VAT (moms) owed or the VAT overview",
      search: "Find or go to a page, list, setting or record (for instance the customer list, invoices, settings), or text too short or unclear to tell",
    },
  },
}

export async function decideRequest(input: { apiKey: string; text: string; signal?: AbortSignal }): Promise<RequestDecision | null> {
  const signal = AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), ...(input.signal ? [input.signal] : [])])
  try {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      signal,
      headers: { Authorization: `Bearer ${input.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "jev-latest", state: input.text, questions: QUESTIONS }),
    })
    if (!response.ok) return null
    const { answers } = responseSchema.parse(await response.json())
    const kind = DECISION_KINDS.find((candidate) => candidate === answers.intent.choice)
    if (!kind) return null
    return { kind, probability: answers.intent.probabilities[kind] ?? 0 }
  } catch {
    // Timeouts, aborts and upstream errors leave ordinary search. Bodies can echo the text: not logged.
    return null
  }
}
