import type { DocumentLineInput } from "@quits/contracts/invoices"

import { trpc } from "../trpc/client"
import type { InvoiceHandoff } from "./request-handoff"

/** The lines of a customer's last issued invoice, as the request card and the form take them. */
export type LastInvoice = { number: string | null; pricesIncludeTax: boolean; items: InvoiceHandoff["items"] }

/** The customer's newest issued invoice in the organization's currency, its lines copied as stored (price basis and VAT as they were). */
export async function loadLastInvoice(contactId: string, currency: string): Promise<LastInvoice | null> {
  const invoices = await trpc.invoices.list.query()
  const last = invoices.find(invoice => invoice.contactId === contactId && invoice.status !== "draft" && invoice.currency === currency)
  if (!last) return null
  const full = await trpc.invoices.get.query({ id: last.id })
  return {
    number: full.number,
    pricesIncludeTax: full.pricesIncludeTax,
    items: full.items.map(item => ({
      description: item.description,
      quantity: String(item.quantity),
      unitPrice: String(item.displayUnitPrice),
      ...(item.vatTreatment !== "standard" && {
        vat: { treatment: item.vatTreatment, rate: item.vatRateInput ?? undefined, country: item.vatCountry, reasonCode: item.vatReasonCode } as DocumentLineInput["vat"],
      }),
    })),
  }
}
