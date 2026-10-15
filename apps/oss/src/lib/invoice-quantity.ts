import { z } from "zod"
import { quantityDecimalSchema } from "@quits/contracts/invoices"

// Keep raw editor text until validation. Either "," or "." is read as the decimal separator,
// never as grouping. A value that reads like the locale's thousands grouping ("1,000" in
// English, "1.000" in Danish) is rejected rather than silently saved 1000x too small.
// API and pricing inputs remain canonical decimal-point strings.
function groupingSeparator(locale: string): "," | "." {
  const decimal = new Intl.NumberFormat(locale).formatToParts(1.5).find(part => part.type === "decimal")?.value
  return decimal === "," ? "." : ","
}

export function invoiceQuantityInput(locale: string) {
  const grouping = groupingSeparator(locale)
  return z.string()
    .refine(value => !new RegExp(`^\\d+\\${grouping}\\d{3}$`).test(value))
    .transform(value => value.replace(",", "."))
    .pipe(quantityDecimalSchema)
}

export function normalizeInvoiceQuantity<T extends { quantity: string }>(item: T, locale: string): T {
  const parsed = invoiceQuantityInput(locale).safeParse(item.quantity)
  return parsed.success ? { ...item, quantity: parsed.data } : item
}
