import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Prisma } from "../../../generated/prisma/client"
import { prisma } from "../../lib/db"
import { createTestOrganization, hasTestDatabase } from "../../test-utils/organization"
import { createInvoiceDraft } from "../../domain/commands/invoices"
import { createQuoteDraft } from "../../domain/commands/quotes"
import { appRouter } from "../../trpc/router"
import { executeCommand } from "../../domain/execute"
import { issueDocument } from "../issuance"
import { documentPdf } from "../../lib/documents/pdf-access"
import { buildTotals } from "../../lib/documents/totals"
import { priceBasis } from "../../lib/documents/line-amounts"
import { vatRowsByRate } from "../../domain/documents/frozen-vat-groups"
import { composeInvoiceEmail } from "../../domain/documents/invoice-email"
import type { RenderInput } from "../../domain/documents/render-input"

const cleanups: Array<() => Promise<void>> = []
beforeEach(() => {
  // Without an email provider an invoice can be issued without sending an email.
  vi.stubEnv("RESEND_API_KEY", "")
})
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.()
  vi.unstubAllEnvs()
})

const sum = (values: number[], exponent = 2) =>
  values.reduce((total, value) => total.plus(value.toFixed(exponent)), new Prisma.Decimal(0)).toFixed(exponent)

async function issued(options: { pricesIncludeTax: boolean; currency?: string; items: Array<{ description: string; quantity: string; unitPrice: string; vat?: { treatment: "standard"; rate: string } }> }) {
  const org = await createTestOrganization()
  cleanups.push(org.cleanup)
  await prisma.orgSettings.update({ where: { organizationId: org.organizationId }, data: { pricesIncludeTax: options.pricesIncludeTax, baseCurrency: options.currency ?? "DKK" } })
  const contact = await prisma.contact.create({ data: { organizationId: org.organizationId, name: "Customer", email: "customer@example.test" } })
  const created = await executeCommand(createInvoiceDraft, {
    contactId: contact.id, dueDate: "2099-01-01", supplyDate: "2026-10-01", currency: options.currency ?? "DKK", taxRate: "25", items: options.items,
  }, { actor: org.actors.admin })
  if (created.status !== "completed") throw new Error(JSON.stringify(created))
  const result = await issueDocument({
    kind: "invoice", actor: org.actors.admin,
    commandInput: { id: created.result.id, allowSendWithoutEmail: true, supplyDate: "2026-10-02" },
  })
  expect(result, JSON.stringify(result)).toMatchObject({ status: "completed" })
  const response = await documentPdf("invoice", created.result.id, org.organizationId)
  expect(response.headers.get("X-Quits-Artifact")).toBe("stored")
  // The synthetic test renderer writes the render input as the PDF.
  const input = JSON.parse(await response.text()) as RenderInput & { kind: "invoice" }
  const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: created.result.id } })
  return { org, invoice, input, pdf: input.pdf.invoice }
}

;(hasTestDatabase ? describe : describe.skip)("PDF line amounts of issued documents", () => {
  it("freezes net lines that add up to the subtotal when prices exclude VAT", async () => {
    const { invoice, pdf } = await issued({ pricesIncludeTax: false, items: [
      { description: "Rådgivning", quantity: "2", unitPrice: "4000" },
      { description: "Licens", quantity: "1", unitPrice: "6500" },
    ] })
    expect(pdf.pricesIncludeTax).toBe(false)
    expect(pdf.items.map((line) => [line.unitPrice, line.total])).toEqual([[4000, 8000], [6500, 6500]])
    expect(sum(pdf.items.map((line) => line.total))).toBe(invoice.subtotalNet.toFixed(2))
    expect(pdf).toMatchObject({ subtotal: 14500, taxAmount: 3625, total: 18125 })
    expect(pdf.vatRows).toEqual([{ ratePercent: "25", net: "14500.00", tax: "3625.00", gross: "18125.00" }])
  })

  it("freezes gross lines that add up to the total when prices include VAT", async () => {
    const { invoice, pdf } = await issued({ pricesIncludeTax: true, items: [
      { description: "A", quantity: "3", unitPrice: "33.33" },
      { description: "B", quantity: "1", unitPrice: "0.05" },
      { description: "C", quantity: "7", unitPrice: "12.49" },
    ] })
    expect(pdf.pricesIncludeTax).toBe(true)
    expect(sum(pdf.items.map((line) => line.total))).toBe(invoice.totalGross.toFixed(2))
  })

  it("groups the VAT by rate and keeps the lines adding up", async () => {
    const { invoice, pdf } = await issued({ pricesIncludeTax: false, items: [
      { description: "Standard", quantity: "1", unitPrice: "1000" },
      { description: "Reduced", quantity: "2", unitPrice: "100.50", vat: { treatment: "standard", rate: "0.05" } },
    ] })
    expect(pdf.vatRows).toEqual([
      { ratePercent: "5", net: "201.00", tax: "10.05", gross: "211.05" },
      { ratePercent: "25", net: "1000.00", tax: "250.00", gross: "1250.00" },
    ])
    expect(sum(pdf.items.map((line) => line.total))).toBe(invoice.subtotalNet.toFixed(2))
    expect(sum(pdf.vatRows!.map((row) => Number(row.tax)))).toBe(invoice.totalTax.toFixed(2))
    // The rows are the frozen money groups the e-invoice is built from, by rate.
    const frozen = (invoice.issuanceSnapshot as { vatGroups: Array<{ rate: string; net: string; tax: string; gross: string }> }).vatGroups
    expect(pdf.vatRows).toEqual(vatRowsByRate(frozen, "DKK"))
  })

  it("freezes whole units for a currency without minor units", async () => {
    const { invoice, pdf } = await issued({ pricesIncludeTax: false, currency: "JPY", items: [
      { description: "A", quantity: "3", unitPrice: "105" },
      { description: "B", quantity: "1", unitPrice: "999" },
    ] })
    expect(pdf.items.map((line) => line.total)).toEqual([315, 999])
    expect(sum(pdf.items.map((line) => line.total), 0)).toBe(invoice.subtotalNet.toFixed(0))
    expect(pdf.vatRows?.map((row) => row.tax)).toEqual(["329"])
  })

  it("freezes the supply date confirmed at issuance, not the draft's", async () => {
    const { pdf, invoice } = await issued({ pricesIncludeTax: false, items: [{ description: "A", quantity: "1", unitPrice: "100" }] })
    expect(pdf.supplyDate).toBe("2026-10-02")
    expect(invoice.supplyDate?.toISOString().slice(0, 10)).toBe("2026-10-02")
  })

  it("mirrors the invoice's basis on its credit note", async () => {
    const { org, invoice } = await issued({ pricesIncludeTax: false, items: [
      { description: "Rådgivning", quantity: "2", unitPrice: "4000" },
      { description: "Licens", quantity: "1", unitPrice: "6500" },
    ] })
    const credit = await issueDocument({
      kind: "creditNote", actor: org.actors.admin,
      commandInput: { invoiceId: invoice.id, mode: "full", reason: "Correction" },
    })
    expect(credit, JSON.stringify(credit)).toMatchObject({ status: "completed" })
    const note = await prisma.creditNote.findFirstOrThrow({ where: { invoiceId: invoice.id } })
    const response = await documentPdf("creditNote", note.id, org.organizationId)
    const input = JSON.parse(await response.text()) as RenderInput & { kind: "creditNote" }
    const pdf = input.pdf.creditNote
    expect(pdf.pricesIncludeTax).toBe(false)
    expect(pdf.items.map((line) => line.total)).toEqual([8000, 6500])
    expect(sum(pdf.items.map((line) => line.total))).toBe(note.subtotalNet.toFixed(2))
    expect(pdf.vatRows).toEqual([{ ratePercent: "25", net: "14500.00", tax: "3625.00", gross: "18125.00" }])
  })

  it("returns the detail pages' lines on the same basis, beside the unchanged gross fields", async () => {
    const org = await createTestOrganization()
    cleanups.push(org.cleanup)
    await prisma.orgSettings.update({ where: { organizationId: org.organizationId }, data: { pricesIncludeTax: false, baseCurrency: "DKK" } })
    const contact = await prisma.contact.create({ data: { organizationId: org.organizationId, name: "Customer", email: "customer@example.test" } })
    const items = [{ description: "Rådgivning", quantity: "2", unitPrice: "4000" }, { description: "Licens", quantity: "1", unitPrice: "6500" }]
    const invoice = await executeCommand(createInvoiceDraft, { contactId: contact.id, dueDate: "2099-01-01", supplyDate: "2026-10-01", currency: "DKK", taxRate: "25", items }, { actor: org.actors.admin })
    const quote = await executeCommand(createQuoteDraft, { contactId: contact.id, expiryDate: "2099-01-01", currency: "DKK", taxRate: "25", items } as never, { actor: org.actors.admin })
    if (invoice.status !== "completed" || quote.status !== "completed") throw new Error(JSON.stringify({ invoice, quote }))
    const caller = appRouter.createCaller({
      session: { user: { id: org.actors.admin.userId, email: "admin@test.quits.invalid", name: "admin" }, session: { activeOrganizationId: org.organizationId } },
    } as never)

    for (const page of [await caller.invoices.get({ id: invoice.result.id }), await caller.quotes.get({ id: quote.result.id })]) {
      expect(page.priceBasis).toBe("net")
      expect(page.items.map((item) => [item.displayUnitPrice, item.displayAmount])).toEqual([[4000, 8000], [6500, 6500]])
      // The long-standing fields stay gross for API callers.
      expect(page.items.map((item) => [item.unitPrice, item.total])).toEqual([[5000, 10000], [8125, 8125]])
      expect(page.vatRows).toEqual([{ ratePercent: "25", net: "14500.00", tax: "3625.00", gross: "18125.00" }])
      expect(page).toMatchObject({ subtotal: 14500, taxAmount: 3625, total: 18125 })
    }

    await prisma.orgSettings.update({ where: { organizationId: org.organizationId }, data: { pricesIncludeTax: true } })
    const gross = await executeCommand(createInvoiceDraft, { contactId: contact.id, dueDate: "2099-01-01", supplyDate: "2026-10-01", currency: "DKK", taxRate: "25", items }, { actor: org.actors.admin })
    if (gross.status !== "completed") throw new Error(JSON.stringify(gross))
    const page = await caller.invoices.get({ id: gross.result.id })
    expect(page.priceBasis).toBe("gross")
    expect(page.items.map((item) => [item.displayUnitPrice, item.displayAmount])).toEqual([[4000, 8000], [6500, 6500]])
  })

  it("prints the rounding of a gross-priced document on the PDF input, the detail payload and the email", async () => {
    // 10,12 including 25 % VAT: net 8,10 and tax 2,03 add up to a cent over the total.
    const { org, invoice, pdf } = await issued({ pricesIncludeTax: true, items: [{ description: "Vare", quantity: "1", unitPrice: "10.12" }] })
    expect(pdf).toMatchObject({ subtotal: 8.1, taxAmount: 2.03, total: 10.12, rounding: "-0.01" })
    // The issued money snapshot says the same, which is what the e-invoice carries as PayableRoundingAmount.
    expect((invoice.issuanceSnapshot as { totals: { payableRounding: string } }).totals.payableRounding).toBe("-0.01")

    const caller = appRouter.createCaller({
      session: { user: { id: org.actors.admin.userId, email: "admin@test.quits.invalid", name: "admin" }, session: { activeOrganizationId: org.organizationId } },
    } as never)
    const page = await caller.invoices.get({ id: invoice.id })
    expect(page).toMatchObject({ priceBasis: "gross", rounding: "-0.01", vatRows: pdf.vatRows })

    const full = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id }, include: { contact: true, items: { orderBy: { sortOrder: "asc" } } } })
    const settings = await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: org.organizationId } })
    const html = composeInvoiceEmail({ invoice: { ...full, number: full.number! }, settings, to: "customer@example.test", publicPaymentUrl: null }).message.html ?? ""
    const text = html.replace(/<[^>]+>/g, " ").replace(/[\u00a0\u202f]/g, " ").replace(/\s+/g, " ")
    expect(text).toContain("Subtotal excl. tax")
    expect(text).toContain("Rounding -DKK 0.01")
    expect(text).toContain("Total incl. tax")
  })
})

/** What the printed rows of a render input add up to, as exact decimals. */
function printedRows(pdf: { pricesIncludeTax?: boolean; subtotal: number; taxAmount: number; total: number; currency: string; vatRows?: Array<{ ratePercent: string; net: string; tax: string; gross: string }>; rounding?: string }) {
  const totals = buildTotals({ basis: priceBasis(pdf.pricesIncludeTax), ...pdf, locale: "en-US" })
  const sumOfRows = totals.lines.reduce((total, line) => total.plus(line.amount), new Prisma.Decimal(0))
  return { totals, sumOfRows: sumOfRows.toFixed(2) }
}

;(hasTestDatabase ? describe : describe.skip)("credit notes mirror the invoice's basis and add up", () => {
  const items = [
    { description: "Rådgivning", quantity: "3", unitPrice: "1333.33" },
    { description: "Kursus", quantity: "2", unitPrice: "250.50", vat: { treatment: "standard" as const, rate: "0.05" } },
    { description: "Licens", quantity: "1", unitPrice: "6500.07" },
  ]

  for (const pricesIncludeTax of [false, true]) {
    it(`credits part of the lines and an amount on a ${pricesIncludeTax ? "gross" : "net"} invoice`, async () => {
      const { org, invoice } = await issued({ pricesIncludeTax, items })
      const stored = await prisma.invoiceItem.findMany({ where: { invoiceId: invoice.id }, orderBy: { sortOrder: "asc" } })
      const caller = appRouter.createCaller({
        session: { user: { id: org.actors.admin.userId, email: "admin@test.quits.invalid", name: "admin" }, session: { activeOrganizationId: org.organizationId } },
      } as never)

      const selections = [
        { mode: "lines", lines: [{ invoiceItemId: stored[0]!.id, quantity: 1 }, { invoiceItemId: stored[1]!.id, quantity: 1 }], reason: "Partial" },
        { mode: "amount", amount: 123.45, reason: "Goodwill" },
      ]
      for (const selection of selections) {
        const credit = await issueDocument({ kind: "creditNote", actor: org.actors.admin, commandInput: { invoiceId: invoice.id, ...selection } })
        expect(credit, JSON.stringify(credit)).toMatchObject({ status: "completed" })
      }
      const notes = await prisma.creditNote.findMany({ where: { invoiceId: invoice.id }, orderBy: { issueDate: "asc" } })
      expect(notes).toHaveLength(2)

      for (const note of notes) {
        const response = await documentPdf("creditNote", note.id, org.organizationId)
        const pdf = (JSON.parse(await response.text()) as RenderInput & { kind: "creditNote" }).pdf.creditNote
        const where = `${note.reason} on a ${pricesIncludeTax ? "gross" : "net"} invoice`
        expect(pdf.pricesIncludeTax, where).toBe(pricesIncludeTax)

        // The printed lines add up to the credit's subtotal (net) or total (gross).
        const lines = pdf.items.reduce((total, line) => total.plus(line.total.toFixed(2)), new Prisma.Decimal(0)).toFixed(2)
        expect(lines, `${where}: lines`).toBe((pricesIncludeTax ? pdf.total : pdf.subtotal).toFixed(2))

        // The rows add up to the total, and the stored note says what the PDF says.
        const { totals, sumOfRows } = printedRows(pdf)
        expect(sumOfRows, `${where}: rows`).toBe(new Prisma.Decimal(totals.total.amount).toFixed(2))
        expect(pdf.rounding, where).toBe(new Prisma.Decimal(note.totalGross.toString()).minus(note.subtotalNet.toString()).minus(note.totalTax.toString()).toFixed(2))

        // The detail page reads the stored items; the PDF reads the credited groups. They agree.
        const page = await caller.creditNotes.get({ id: note.id })
        expect(page.priceBasis, where).toBe(pricesIncludeTax ? "gross" : "net")
        expect(page.rounding, where).toBe(pdf.rounding)
        expect(page.vatRows, where).toEqual(pdf.vatRows)
        expect(page.items.map((item) => item.displayAmount), where).toEqual(pdf.items.map((item) => item.total))
      }
    })
  }
})
