import { z } from "zod"
import { quantityDecimalSchema } from "@quits/contracts/invoices"

// Keep raw editor text until validation. Either "," or "." is read as the decimal separator,
// never as grouping. A value that reads like the locale's thousands grouping ("1,000" in
// English, "1.000" in Danish) is rejected rather than silently saved 1000x too small;
// values below 1 ("0.125") cannot be grouping and stay valid.
// API and pricing inputs remain canonical decimal-point strings.
function decimalSeparator(locale: string): "," | "." {
  const decimal = new Intl.NumberFormat(locale).formatToParts(1.5).find(part => part.type === "decimal")?.value
  return decimal === "," ? "," : "."
}

function groupingSeparator(locale: string): "," | "." {
  return decimalSeparator(locale) === "," ? "." : ","
}

// Persisted quantities are canonical ("1.000" = 1). Show them with the locale's decimal
// separator so editing never reads them as grouped thousands.
export function localizeInvoiceQuantity(canonical: string, locale: string): string {
  return decimalSeparator(locale) === "," ? canonical.replace(".", ",") : canonical
}

export function invoiceQuantityInput(locale: string) {
  const grouping = groupingSeparator(locale)
  return z.string()
    .refine(value => !new RegExp(`^[1-9]\\d{0,2}\\${grouping}\\d{3}$`).test(value))
    .transform(value => value.replace(",", "."))
    .pipe(quantityDecimalSchema)
}

export function normalizeInvoiceQuantity<T extends { quantity: string }>(item: T, locale: string): T {
  const parsed = invoiceQuantityInput(locale).safeParse(item.quantity)
  return parsed.success ? { ...item, quantity: parsed.data } : item
}
