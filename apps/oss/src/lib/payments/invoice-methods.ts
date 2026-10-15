/** Older invoices have no selection and retain their existing payment options. */
export function invoiceAllowsPayment(methods: unknown, method: "bank_transfer" | "card"): boolean {
  return methods == null || Array.isArray(methods) && methods.includes(method)
}
