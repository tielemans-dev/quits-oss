/** Invented fixtures using the documented shapes, never real provider/account evidence. */
export const customer = { customerNumber: 7, name: "Synthetic customer", balance: 125, currency: "DKK" }
export const invoice = { bookedInvoiceNumber: 10, customer: { customerNumber: 7 }, date: "2026-10-01", currency: "DKK", exchangeRate: 100, netAmount: 100, vatAmount: 25, grossAmount: 125, grossAmountInBaseCurrency: 125, remainder: 125, remainderInBaseCurrency: 125, pdf: { download: "https://restapi.e-conomic.com/invoices/booked/10/pdf" } }
export const entry = { entryNumber: 99, accountNumber: 5600, customerNumber: 7, customerInvoiceNumber: 10, amount: 125, amountInBaseCurrency: 125, currencyCode: "DKK", remainder: 125, date: "2026-10-01T00:00:00", type: 1, voucherNumber: 10 }
export const attachment = { number: 5, accountingYear: "2026", voucherNumber: 10, pageCount: 1 }
export const year = { year: "2026", fromDate: "2026-01-01", toDate: "2026-12-31" }
export function fixtureResponse(url: URL): Response {
  const path = url.pathname
  if (path === "/self") return Response.json({ agreementNumber: 123, settings: { baseCurrency: "DKK" } })
  if (path.endsWith("/pdf")) return new Response("%PDF-1.4\nSynthetic fixture, not a real provider document\n", { headers: { "content-type": "application/pdf" } })
  if (path.endsWith("/count")) return Response.json(1)
  if (path.endsWith("/booked-entries/matched-pairs")) return Response.json({ items: [] })
  if (path.endsWith("/booked-entries")) return Response.json({ items: [entry] })
  if (path.endsWith("/AttachedDocuments")) return Response.json({ items: [attachment] })
  const records = path === "/customers" ? [customer] : path === "/invoices/booked" ? [invoice] : path === "/accounting-years" ? [year] : null
  if (records) return Response.json({ collection: records, pagination: { results: 1, pageSize: url.searchParams.get("pagesize"), skipPages: 0 } })
  throw new Error("Unexpected test path")
}
export const fixtureFetch = (async (input: RequestInfo | URL) => fixtureResponse(new URL(String(input)))) as typeof fetch
