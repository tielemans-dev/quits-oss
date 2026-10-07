import { afterEach, describe, expect, it } from "vitest"
import { previewDraft, calculateDraft } from "@quits/shared/pricing"
import type { DocumentLineInput } from "@quits/contracts/invoices"
import { prisma } from "../../lib/db"
import { createTestOrganization, hasTestDatabase } from "../../test-utils/organization"
import { createContact } from "../commands/contacts"
import { createInvoiceDraft, updateInvoiceDraft, sendInvoice, resendInvoiceEmail } from "../commands/invoices"
import { createQuoteDraft, updateQuoteDraft, convertQuoteToInvoice, sendQuote } from "../commands/quotes"
import { createRecurringInvoice, updateRecurringInvoice, runRecurringInvoiceNow } from "../commands/recurring"
import { recordPayment } from "../commands/payments"
import { documentFingerprint } from "../approval-contexts"
import { executeCommand } from "../execute"

const fixtures: Array<{ currency: string; pricesIncludeTax: boolean; taxRate: string; items: DocumentLineInput[] }> = [
  { currency: "JPY", pricesIncludeTax: false, taxRate: "25", items: [{ description: "Half", quantity: "0.5", unitPrice: "100" }] },
  { currency: "DKK", pricesIncludeTax: false, taxRate: "25", items: Array.from({ length: 3 }, () => ({ description: "Remainder", quantity: "1", unitPrice: "0.02" })) },
  { currency: "DKK", pricesIncludeTax: true, taxRate: "25", items: [{ description: "Negative rounding", quantity: "1", unitPrice: "0.02" }] },
  { currency: "USD", pricesIncludeTax: false, taxRate: "25", items: [
    { description: "Standard", quantity: "0.123456", unitPrice: "123.4567" },
    { description: "Exempt", quantity: "1", unitPrice: "100", vat: { treatment: "exempt", reasonCode: "health" } },
  ] },
]

describe.skipIf(!hasTestDatabase)("v2 producer and editor parity", () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => { while (cleanups.length) await cleanups.pop()?.() })
  async function setup(currency = "USD", pricesIncludeTax = false) {
    const org = await createTestOrganization({ settings: { currency, pricesIncludeTax } })
    cleanups.push(org.cleanup)
    const contact = await executeCommand(createContact, { name: "VAT customer", email: "vat@example.test", country: "US" }, { actor: org.actors.admin })
    if (contact.status !== "completed") throw new Error(JSON.stringify(contact))
    return { org, contactId: contact.result.id, options: { actor: org.actors.admin } }
  }
  it.each(fixtures)("editor preview equals server command for $currency, inclusive $pricesIncludeTax", async (fixture) => {
    const { contactId, options } = await setup(fixture.currency, fixture.pricesIncludeTax)
    const preview = previewDraft(fixture)
    expect(preview.error).toBeNull()
    const created = await executeCommand(createInvoiceDraft, { ...fixture, contactId, dueDate: "2026-12-01" }, options)
    if (created.status !== "completed") throw new Error(JSON.stringify(created))
    const doc = created.result
    const exponent = preview.result!.calculation.exponent
    expect(doc.calculationVersion).toBe("v2")
    expect([doc.subtotalNet.toFixed(exponent), doc.totalTax.toFixed(exponent), doc.totalGross.toFixed(exponent)]).toEqual([preview.result!.net, preview.result!.tax, preview.result!.gross])
    doc.items.forEach((item, index) => {
      const line = preview.result!.lines[index]!
      expect([item.lineNet.toFixed(exponent), item.lineTax.toFixed(exponent), item.lineGross.toFixed(exponent)]).toEqual([line.net, line.tax, line.gross])
      expect([item.quantityInput, item.unitPriceInput, item.inputPrecision]).toEqual([line.quantity, line.unitPrice, "string"])
    })
    if (fixture.pricesIncludeTax) await prisma.orgSettings.update({ where: { organizationId: doc.organizationId }, data: { pricesIncludeTax: false } })
    const edited = await executeCommand(updateInvoiceDraft, { id: doc.id, notes: "Changed" }, options)
    if (edited.status !== "completed") throw new Error(JSON.stringify(edited))
    expect(edited.result.totalGross.toString()).toBe(doc.totalGross.toString())
    expect(edited.result.items.map((item) => [item.quantityInput, item.unitPriceInput])).toEqual(doc.items.map((item) => [item.quantityInput, item.unitPriceInput]))
  })
  it("upgrades a legacy draft on a no-item edit and never reprices an issued legacy invoice", async () => {
    const { org, contactId, options } = await setup()
    const createLegacy = (number: string, status: string) => prisma.invoice.create({ data: {
      organizationId: org.organizationId, contactId, number, status, dueDate: new Date("2026-12-01"), currency: "USD", subtotalNet: "0.06", totalTax: "0.03", totalGross: "0.09",
      items: { create: Array.from({ length: 3 }, (_, sortOrder) => ({ description: "Legacy", quantity: "1", quantityInput: "1", unitPriceNet: "0.02", unitPriceGross: "0.03", unitPriceInput: "0.02", inputPrecision: "backfilled", lineNet: "0.02", lineTax: "0.01", lineGross: "0.03", taxRate: "25", vatTreatment: "standard", sortOrder })) },
    }, include: { items: true } })
    const draft = await createLegacy("LEGACY-DRAFT", "draft")
    const issued = await createLegacy("LEGACY-ISSUED", "sent")
    const updated = await executeCommand(updateInvoiceDraft, { id: draft.id, notes: "Upgrade" }, options)
    if (updated.status !== "completed") throw new Error(JSON.stringify(updated))
    expect(updated.result.calculationVersion).toBe("v2")
    expect(updated.result.totalGross.toString()).toBe("0.08")
    expect(updated.result.items.every((item) => item.inputPrecision === "backfilled")).toBe(true)
    const outcomes = [
      await executeCommand(updateInvoiceDraft, { id: issued.id }, options),
      await executeCommand(sendInvoice, { id: issued.id }, options),
      await executeCommand(resendInvoiceEmail, { id: issued.id }, options),
    ]
    for (const outcome of outcomes) expect(outcome.status).toBe("failed")
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: issued.id }, include: { items: true } })).toEqual(issued)
    expect((await executeCommand(recordPayment, { invoiceId: issued.id, amount: 0.01, paidAt: "2026-01-01", method: "cash" }, options)).status).toBe("completed")
    const paid = await prisma.invoice.findUniqueOrThrow({ where: { id: issued.id }, include: { items: true } })
    expect([paid.calculationVersion, paid.subtotalNet.toString(), paid.totalTax.toString(), paid.totalGross.toString(), paid.items]).toEqual([issued.calculationVersion, issued.subtotalNet.toString(), issued.totalTax.toString(), issued.totalGross.toString(), issued.items])
  })
  it.each(["v2", "legacy_per_line"])("conversion copies %s quote version and frozen figures without repricing", async (version) => {
    const { contactId, options } = await setup()
    const created = await executeCommand(createQuoteDraft, { contactId, expiryDate: "2026-12-01", ...fixtures[3], vatEvidence: { statementText: "Health exemption" } }, options)
    if (created.status !== "completed") throw new Error(JSON.stringify(created))
    await prisma.quote.update({ where: { id: created.result.id }, data: { status: "accepted", calculationVersion: version, totalGross: "999.99" } })
    const quote = await prisma.quote.findUniqueOrThrow({ where: { id: created.result.id }, include: { items: { orderBy: { sortOrder: "asc" } } } })
    const converted = await executeCommand(convertQuoteToInvoice, { id: quote.id }, options)
    if (converted.status !== "completed") throw new Error(JSON.stringify(converted))
    expect(converted.result.calculationVersion).toBe(version)
    expect(converted.result.totalGross.toString()).toBe("999.99")
    expect(converted.result.vatEvidence).toEqual(quote.vatEvidence)
    expect(converted.result.items.map(({ id: _id, invoiceId: _invoice, deliverableId: _deliverable, ...item }) => item)).toEqual(quote.items.map(({ id: _id, quoteId: _quote, ...item }) => item))
  })
  it("quote no-item editing preserves original inputs and upgrades the version", async () => {
    const { contactId, options } = await setup()
    const created = await executeCommand(createQuoteDraft, { contactId, expiryDate: "2026-12-01", taxRate: "25", items: [{ description: "Precise", quantity: "0.123456", unitPrice: "123.4567" }] }, options)
    if (created.status !== "completed") throw new Error(JSON.stringify(created))
    await prisma.quote.update({ where: { id: created.result.id }, data: { calculationVersion: "legacy_per_line" } })
    const edited = await executeCommand(updateQuoteDraft, { id: created.result.id, notes: "Edit" }, options)
    if (edited.status !== "completed") throw new Error(JSON.stringify(edited))
    expect(edited.result.calculationVersion).toBe("v2")
    expect(edited.result.totalGross.toString()).toBe(created.result.totalGross.toString())
    expect(edited.result.items[0]).toMatchObject({ quantityInput: "0.123456", unitPriceInput: "123.4567" })
  })
  it("recurring runs price on v2 and propagate schedule evidence and original inputs", async () => {
    const { contactId, options } = await setup()
    const input = { contactId, name: "Health retainer", startDate: "2026-12-01", currency: "USD", taxRate: "25", items: fixtures[3]!.items, vatEvidence: { statementText: "Health exemption" } }
    const created = await executeCommand(createRecurringInvoice, input, options)
    if (created.status !== "completed") throw new Error(JSON.stringify(created))
    const run = await executeCommand(runRecurringInvoiceNow, { id: created.result.id }, options)
    expect(run.status).toBe("completed")
    const invoice = await prisma.invoice.findFirstOrThrow({ where: { recurringInvoiceId: created.result.id }, include: { items: { orderBy: { sortOrder: "asc" } } } })
    expect(invoice.calculationVersion).toBe("v2")
    expect(invoice.vatEvidence).toEqual(input.vatEvidence)
    expect(invoice.items[0]).toMatchObject({ quantityInput: "0.123456", unitPriceInput: "123.4567", inputPrecision: "string" })
    expect(invoice.totalGross.toFixed(2)).toBe(calculateDraft({ ...input, pricesIncludeTax: false }).gross)
  })
  it("recurring generation preserves the exact convenience VAT rate in its template lines", async () => {
    const { contactId, options } = await setup()
    const created = await executeCommand(createRecurringInvoice, { contactId, name: "Precise rate", startDate: "2026-12-01", currency: "USD", taxRate: "8.2555", items: [{ description: "Retainer", quantity: "1", unitPrice: "1000" }] }, options)
    if (created.status !== "completed") throw new Error(JSON.stringify(created))
    expect((await executeCommand(runRecurringInvoiceNow, { id: created.result.id }, options)).status).toBe("completed")
    const invoice = await prisma.invoice.findFirstOrThrow({ where: { recurringInvoiceId: created.result.id }, include: { items: true } })
    expect(invoice.items[0]?.vatRateInput).toBe("0.082555")
    expect(invoice.totalTax.toString()).toBe("82.56")
  })
  it("recurring edits preserve exact rates and apply a new convenience rate before generation", async () => {
    const { contactId, options } = await setup()
    const created = await executeCommand(createRecurringInvoice, { contactId, name: "Precise rate", startDate: "2026-12-01", currency: "USD", taxRate: "8.2555", items: [{ description: "Retainer", quantity: "1", unitPrice: "1000" }] }, options)
    if (created.status !== "completed") throw new Error(JSON.stringify(created))
    const edit = await executeCommand(updateRecurringInvoice, { id: created.result.id, items: [{ description: "Updated", quantity: "1", unitPrice: "2000" }] }, options)
    if (edit.status !== "completed") throw new Error(JSON.stringify(edit))
    expect(edit.result.items).toMatchObject([{ vat: { rate: "0.082555" } }])
    const rateEdit = await executeCommand(updateRecurringInvoice, { id: created.result.id, taxRate: "9.1234" }, options)
    if (rateEdit.status !== "completed") throw new Error(JSON.stringify(rateEdit))
    expect(rateEdit.result.items).toMatchObject([{ vat: { rate: "0.091234" } }])
    expect((await executeCommand(runRecurringInvoiceNow, { id: created.result.id }, options)).status).toBe("completed")
    const invoice = await prisma.invoice.findFirstOrThrow({ where: { recurringInvoiceId: created.result.id }, include: { items: true } })
    expect(invoice.items[0]?.vatRateInput).toBe("0.091234")
    expect(invoice.totalTax.toString()).toBe("182.47")
  })
  it.each([[], { malformed: true }])("tax-only recurring edits refuse invalid stored items %j without replacing them", async (items) => {
    const { contactId, options } = await setup()
    const created = await executeCommand(createRecurringInvoice, { contactId, name: "Invalid template", startDate: "2026-12-01", items: [{ description: "Retainer", quantity: "1", unitPrice: "100" }] }, options)
    if (created.status !== "completed") throw new Error(JSON.stringify(created))
    const schedule = await prisma.recurringInvoice.update({ where: { id: created.result.id }, data: { items } })
    expect(await executeCommand(updateRecurringInvoice, { id: schedule.id, taxRate: "25" }, options)).toMatchObject({ status: "failed", error: { code: "invalid_schedule_items" } })
    expect(await prisma.recurringInvoice.findUniqueOrThrow({ where: { id: schedule.id } })).toEqual(schedule)
    expect(await executeCommand(runRecurringInvoiceNow, { id: schedule.id }, options)).toMatchObject({ status: "failed", error: { code: "invalid_schedule_items" } })
  })
  it("keeps exact decimal VAT rates through persistence and no-item editing", async () => {
    const { contactId, options } = await setup()
    const items = [{ description: "Precise rate", quantity: "1", unitPrice: "1000", vat: { treatment: "standard", rate: "0.082555" } }]
    const created = await executeCommand(createInvoiceDraft, { contactId, dueDate: "2026-12-01", items }, options)
    if (created.status !== "completed") throw new Error(JSON.stringify(created))
    expect(created.result.items[0]).toMatchObject({ vatRateInput: "0.082555" })
    expect(created.result.totalTax.toString()).toBe("82.56")
    const edited = await executeCommand(updateInvoiceDraft, { id: created.result.id, notes: "Preserve" }, options)
    if (edited.status !== "completed") throw new Error(JSON.stringify(edited))
    expect(edited.result.items[0]?.vatRateInput).toBe("0.082555")
    expect(edited.result.totalTax.toString()).toBe("82.56")
  })
  it("accepts a draft with a missing VAT reason and refuses it at issuance", async () => {
    const { contactId, options } = await setup()
    const created = await executeCommand(createInvoiceDraft, { contactId, dueDate: "2026-12-01", items: [{ description: "Exemption", quantity: "1", unitPrice: "100", vat: { treatment: "exempt" } }], vatEvidence: { statementText: "Health exemption" } }, options)
    if (created.status !== "completed") throw new Error(JSON.stringify(created))
    expect(await executeCommand(sendInvoice, { id: created.result.id, allowSendWithoutEmail: true }, options)).toMatchObject({ status: "failed", error: { code: "evidence_incomplete" } })
  })
  it("accepts partial export evidence in a draft but refuses issuance until it is complete", async () => {
    const { contactId, options } = await setup()
    const created = await executeCommand(createInvoiceDraft, { contactId, dueDate: "2026-12-01", items: [{ description: "Export", quantity: "1", unitPrice: "100", vat: { treatment: "export", reasonCode: "goods_outside_eu" } }], vatEvidence: { exportEvidence: { kind: "other" } } }, options)
    if (created.status !== "completed") throw new Error(JSON.stringify(created))
    const refused = await executeCommand(sendInvoice, { id: created.result.id, allowSendWithoutEmail: true }, options)
    expect(refused).toMatchObject({ status: "failed", error: { code: "evidence_incomplete" } })
    const edited = await executeCommand(updateInvoiceDraft, { id: created.result.id, vatEvidence: { exportEvidence: { kind: "other", ref: "EXPORT-1" } } }, options)
    expect(edited.status).toBe("completed")
    const sent = await executeCommand(sendInvoice, { id: created.result.id, allowSendWithoutEmail: true }, options)
    expect(sent).toMatchObject({ status: "completed", result: { status: "sent" } })
  })
  it("refuses an inconsistent stored equation without repricing the draft at issuance", async () => {
    const { contactId, options } = await setup()
    const created = await executeCommand(createInvoiceDraft, { contactId, dueDate: "2026-12-01", taxRate: "25", items: [{ description: "Work", quantity: "1", unitPrice: "100" }] }, options)
    if (created.status !== "completed") throw new Error(JSON.stringify(created))
    await prisma.invoice.update({ where: { id: created.result.id }, data: { totalGross: "126" } })
    expect(await executeCommand(sendInvoice, { id: created.result.id, allowSendWithoutEmail: true }, options)).toMatchObject({ status: "failed", error: { code: "invalid_document_equation" } })
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: created.result.id } })).totalGross.toString()).toBe("126")
  })
  it("issues an intra-community draft using the VAT scheme written by settings", async () => {
    const { org, contactId, options } = await setup()
    await prisma.organizationTaxId.create({ data: { organizationId: org.organizationId, value: "DK12345678", scheme: "vat", countryCode: "DK" } })
    await prisma.contact.update({ where: { id: contactId }, data: { country: "DE" } })
    const evidence = { buyerVatId: "DE123456789", statementText: "Reverse charge", viesCheck: { result: "valid", at: "2026-10-07T00:00:00Z" } }
    const created = await executeCommand(createInvoiceDraft, { contactId, dueDate: "2026-12-01", vatEvidence: evidence, items: [{ description: "Goods", quantity: "1", unitPrice: "100", vat: { treatment: "intra_community", reasonCode: "goods", country: "DE" } }] }, options)
    if (created.status !== "completed") throw new Error(JSON.stringify(created))
    expect(await executeCommand(sendInvoice, { id: created.result.id, allowSendWithoutEmail: true }, options)).toMatchObject({ status: "completed", result: { status: "sent" } })
  })
  it("includes classification, evidence, original inputs and calculation version in approval fingerprints", async () => {
    const { contactId, options } = await setup()
    const created = await executeCommand(createInvoiceDraft, { contactId, dueDate: "2026-12-01", taxRate: "25", items: [{ description: "Work", quantity: "1", unitPrice: "100" }] }, options)
    if (created.status !== "completed") throw new Error(JSON.stringify(created))
    const doc = await prisma.invoice.findUniqueOrThrow({ where: { id: created.result.id }, include: { contact: true, items: true } })
    const version = documentFingerprint(doc, "vat@example.test", [doc.dueDate])
    for (const patch of [
      { vatEvidence: { statementText: "Changed" } }, { calculationVersion: "legacy_per_line" },
      { items: [{ ...doc.items[0]!, unitPriceInput: "100.0001" }] },
      { items: [{ ...doc.items[0]!, vatRateInput: "0.250001" }] },
      { items: [{ ...doc.items[0]!, vatCountry: "DE" }] },
    ]) expect(documentFingerprint({ ...doc, ...patch }, "vat@example.test", [doc.dueDate])).not.toBe(version)
  })
  it("numeric compatibility preserves fractions with String(number), including JPY", async () => {
    const { contactId, options } = await setup("JPY")
    const created = await executeCommand(createInvoiceDraft, { contactId, dueDate: "2026-12-01", currency: "JPY", taxRate: 0, items: [{ description: "Half", quantity: 0.5, unitPrice: 100 }] }, options)
    if (created.status !== "completed") throw new Error(JSON.stringify(created))
    expect(created.result.totalGross.toString()).toBe("50")
    expect(created.result.items[0]).toMatchObject({ quantityInput: "0.5", unitPriceInput: "100", inputPrecision: "number" })
  })
  it.each(["invoice", "quote"])("%s send refuses incomplete evidence then issues stored figures", async (kind) => {
    const { contactId, options } = await setup()
    const fields = { contactId, taxRate: "25", items: fixtures[3]!.items, dueDate: "2026-12-01", expiryDate: "2026-12-01" }
    const created = kind === "invoice" ? await executeCommand(createInvoiceDraft, fields, options) : await executeCommand(createQuoteDraft, fields, options)
    if (created.status !== "completed") throw new Error(JSON.stringify(created))
    const send = () => kind === "invoice"
      ? executeCommand(sendInvoice, { id: created.result.id, allowSendWithoutEmail: true }, options)
      : executeCommand(sendQuote, { id: created.result.id, allowSendWithoutEmail: true }, options)
    expect(await send()).toMatchObject({ status: "failed", error: { code: "evidence_incomplete" } })
    const updated = kind === "invoice"
      ? await executeCommand(updateInvoiceDraft, { id: created.result.id, vatEvidence: { statementText: "Health exemption" } }, options)
      : await executeCommand(updateQuoteDraft, { id: created.result.id, vatEvidence: { statementText: "Health exemption" } }, options)
    expect(updated.status).toBe("completed")
    const sent = await send()
    expect(sent).toMatchObject({ status: "completed", result: { status: "sent", calculationVersion: "v2" } })
    if (sent.status === "completed") expect(sent.result.totalGross.toString()).toBe(created.result.totalGross.toString())
  })
})
