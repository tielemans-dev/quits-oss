import type { CatalogItemOption } from "../../lib/catalog"
import type { RequestCustomer } from "../../lib/request-parser"
import { trpc } from "../../trpc/client"
import type { CreditNoteAvailability } from "../credit-notes/types"
import { onRequestDone } from "./request-events"
import type { RequestIntent } from "./request-intent"

/**
 * What the cards read, shared and kept briefly. The palette starts a card's reads while its request
 * is still being typed, so the card opens with its data instead of filling in after it has grown.
 * A read is reused for a few seconds, which covers typing and pausing, and forgotten once a card
 * has done something, so nothing the person just changed is shown from before.
 */
const FRESH_MS = 10_000
const entries = new Map<string, { at: number; promise: Promise<unknown>; value?: { data: unknown } }>()
onRequestDone(() => entries.clear())

function read<T>(key: string, load: () => Promise<T>): Promise<T> {
  const cached = entries.get(key)
  if (cached && Date.now() - cached.at < FRESH_MS) return cached.promise as Promise<T>
  const entry: { at: number; promise: Promise<unknown>; value?: { data: unknown } } = { at: Date.now(), promise: load() }
  entries.set(key, entry)
  // A failed read is not kept: the card that opens next tries again.
  entry.promise.then((data) => { entry.value = { data } }, () => { if (entries.get(key) === entry) entries.delete(key) })
  return entry.promise as Promise<T>
}

/** A read that has already arrived, for a card's first render. */
function peek<T>(key: string): T | undefined {
  return entries.get(key)?.value?.data as T | undefined
}

/** Every invoice with the organization's timezone: the overdue and payment cards read these. */
export const invoicesKey = "invoices"
export const readInvoices = () =>
  read(invoicesKey, () => Promise.all([trpc.invoices.list.query(), trpc.settings.get.query().catch(() => ({ timezone: null }))])
    .then(([invoices, settings]) => ({ invoices, timezone: settings.timezone ?? null })))

/** Customers and the catalogue, which the invoice card matches the request against. */
export const customersKey = "customers"
export const readCustomers = () =>
  read(customersKey, () => Promise.all([trpc.contacts.list.query(), trpc.catalog.list.query().catch(() => [])])
    .then(([customers, catalogItems]) => ({ customers: customers as RequestCustomer[], catalogItems: catalogItems as CatalogItemOption[] })))

/** The invoice a credit note request names, with what can still be credited; null when there is none. */
const creditKey = (number: string) => `credit:${number}`
export const creditNumber = (input: string) => input.trim().split(/\s+/)[1] ?? ""
export const readCredit = (number: string) =>
  read(creditKey(number), () => trpc.creditNotes.findInvoice.query({ number })
    .then((invoice): Promise<CreditNoteAvailability> | null => invoice ? trpc.creditNotes.availability.query({ invoiceId: invoice.id }) : null))
export const peekCredit = (number: string) => peek<CreditNoteAvailability | null>(creditKey(number))

export const vatKey = "vat"
export const readVat = () => read(vatKey, () => trpc.exports.vatOverview.query())

export { peek as peekRequestData }

/** Starts the reads `intent`'s card will make. Failures are the card's to show when it opens. */
export function prefetchRequest(intent: RequestIntent): void {
  const quiet = (promise: Promise<unknown>) => void promise.catch(() => {})
  if (intent.kind === "overdue" || intent.kind === "payment") quiet(readInvoices())
  else if (intent.kind === "invoice" || intent.kind === "repeat") quiet(readCustomers())
  else if (intent.kind === "creditNote" && creditNumber(intent.input)) quiet(readCredit(creditNumber(intent.input)))
  else if (intent.kind === "vat") quiet(readVat())
}

export function resetRequestDataForTesting(): void {
  entries.clear()
}
