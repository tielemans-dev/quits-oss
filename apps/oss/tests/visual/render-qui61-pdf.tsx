import { mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { renderToBuffer } from "@react-pdf/renderer"
import type { InvoiceForPdf } from "../../src/lib/invoice-pdf"

// MOCK: synthetic document used only by the local visual-review script. Never loaded by the app.
const invoice: InvoiceForPdf = {
  number: "INV-0002", status: "sent", issueDate: "2026-10-11T12:00:00Z", dueDate: "2026-10-25", supplyDate: "2026-10-11",
  subtotal: 1000, taxAmount: 250, total: 1250, currency: "DKK", notes: null, pricesIncludeTax: false,
  vatRows: [{ ratePercent: "25", net: "1000.00", tax: "250.00", gross: "1250.00" }],
  bankAccount: { accountHolder: "Test Studio ApS", bankName: "Test Bank", regNumber: "0000", accountNumber: "0000000000" },
  contact: { name: "Test Customer", company: "Test Buyer ApS", email: "buyer@example.test", address: "Testvej 2", zip: "9000", city: "Aalborg", country: "DK" },
  items: [{ description: "Design", quantity: 2, unitPrice: 500, total: 1000 }],
}
const variant = process.argv[2] ?? "after"
const modulePath = process.env.QUI61_PDF_MODULE ?? "../../src/lib/invoice-pdf.tsx"
const { InvoicePdfDocument } = await import(resolve(import.meta.dirname, modulePath))
const output = resolve(import.meta.dirname, "../../../../docs/qa/qui-61")
await mkdir(output, { recursive: true })
for (const locale of ["da-DK", "en-US"]) {
  const buffer = await renderToBuffer(InvoicePdfDocument({ invoice, org: {
    companyName: "Test Studio ApS", companyAddress: "Testvej 1\n1000 København", companyEmail: "seller@example.test",
    taxIds: [{ scheme: "cvr", value: "12345678", countryCode: "DK" }], locale, timezone: "Europe/Copenhagen",
  } }))
  await writeFile(resolve(output, `pdf-${locale}-${variant}.pdf`), buffer)
}
