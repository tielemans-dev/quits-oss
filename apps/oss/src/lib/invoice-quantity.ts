import { z } from "zod"
import { quantityDecimalSchema } from "@quits/contracts/invoices"

// Keep raw editor text until validation. Commas are decimal separators, never grouping.
// API and pricing inputs remain canonical decimal-point strings.
export const invoiceQuantityInputSchema = z.string()
  .transform(value => value.replace(",", "."))
  .pipe(quantityDecimalSchema)

export function normalizeInvoiceQuantity<T extends { quantity: string }>(item: T): T {
  const parsed = invoiceQuantityInputSchema.safeParse(item.quantity)
  return parsed.success ? { ...item, quantity: parsed.data } : item
}
