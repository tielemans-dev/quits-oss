import type { Invoice } from '../../command-bar/overdue-invoices'
import { readCustomers, readInvoices } from '../../command-bar/request-data'

/** What the palette grounds half-typed requests in: issued invoices and customers, by name. */
export type Known = {
  invoices: Array<{ number: string; customer: string; status: string; balanceDue: number; currency: string; dueDate: string }>
  customers: Array<{ name: string }>
}

/** Fetched once as the palette opens and reused while typing, so suggestions keep up with every key. */
const FRESH_MS = 30_000
let cache: { at: number; promise: Promise<Known>; value: Known | null } | null = null

export function loadKnown(): Promise<Known> {
  if (cache && Date.now() - cache.at < FRESH_MS) return cache.promise
  // The same reads the cards make, so opening the palette starts those too. Each list needs its own
  // permission; without it that half is simply empty.
  const promise = Promise.all([
    readInvoices().then((value) => value.invoices, () => []),
    readCustomers().then((value) => value.customers, () => []),
  ]).then(([invoices, contacts]) => ({
    invoices: (invoices as Array<Invoice>)
      .filter((invoice): invoice is Invoice & { number: string } => Boolean(invoice.number))
      .map((invoice) => ({ number: invoice.number, customer: invoice.contact.name, status: invoice.status, balanceDue: invoice.balanceDue, currency: invoice.currency, dueDate: String(invoice.dueDate) })),
    customers: (contacts as Array<{ name: string }>).map((contact) => ({ name: contact.name })),
  }))
  const entry: NonNullable<typeof cache> = { at: Date.now(), promise, value: null }
  cache = entry
  void promise.then((value) => { entry.value = value })
  return promise
}

/** What is already loaded, without waiting: suggestions answer in the same render when they can. */
export const peekKnown = (): Known | null => cache?.value ?? null

export function resetKnownForTesting(): void {
  cache = null
}
