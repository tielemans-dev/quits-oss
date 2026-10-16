import { z } from "zod"

/**
 * A decision model (TypeSafe's Jev) reading what was typed into the palette, for text the parser
 * cannot read: "hvem skylder mig penge" is a request for overdue invoices. It only chooses, from
 * kinds of request and the organization's own customers, and says how sure it is; it writes
 * nothing, and the cards still read the text themselves. Off unless the operator sets the key.
 */
export const DECISION_KINDS = ["overdue", "invoice", "creditNote", "customer", "payment", "vat", "search"] as const
export type RequestDecision = {
  kind: (typeof DECISION_KINDS)[number]
  /** The model's probability for `kind`, from 0 to 1. */
  probability: number
  customer: { name: string; probability: number } | null
}

const ENDPOINT = "https://api.typesafe.ai/v1/systemone"
/** It answers in about 250ms; past this the person has typed on, and the answer is of no use. */
const TIMEOUT_MS = 2000
/** A choice question takes at most this many options, one of which is "none". */
const MAX_CUSTOMERS = 254

const choiceSchema = z.object({ choice: z.string(), probabilities: z.record(z.string(), z.number()) })
const responseSchema = z.object({ answers: z.object({ intent: choiceSchema, customer: choiceSchema }) })

function questions(customers: readonly string[]) {
  return {
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
    customer: {
      type: "choice",
      instructions: "Which of the organization's customers does the text name, if any? People often write only part of the name (the first word) or misspell it.",
      criteria: {
        ...Object.fromEntries(customers.slice(0, MAX_CUSTOMERS).map((name) => [name, `The customer ${name}`])),
        none: "No customer, or one not in this list",
      },
    },
  }
}

export async function decideRequest(input: { apiKey: string; text: string; customers: readonly string[]; signal?: AbortSignal }): Promise<RequestDecision | null> {
  const signal = AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), ...(input.signal ? [input.signal] : [])])
  try {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      signal,
      headers: { Authorization: `Bearer ${input.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "jev-latest", state: input.text, questions: questions([...new Set(input.customers)]) }),
    })
    if (!response.ok) return null
    const { answers } = responseSchema.parse(await response.json())
    const kind = DECISION_KINDS.find((candidate) => candidate === answers.intent.choice)
    if (!kind) return null
    const customer = answers.customer.choice !== "none" && input.customers.includes(answers.customer.choice)
      ? { name: answers.customer.choice, probability: answers.customer.probabilities[answers.customer.choice] ?? 0 }
      : null
    return { kind, probability: answers.intent.probabilities[kind] ?? 0, customer }
  } catch {
    // Timeouts, aborts and upstream errors leave ordinary search. Bodies can echo the text: not logged.
    return null
  }
}
