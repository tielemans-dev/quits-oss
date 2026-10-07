import { afterEach, describe, expect, it } from "vitest"
import { creditedGroupsSchema } from "@quits/contracts/pricing"
import { prisma } from "../../lib/db"
import { createTestOrganization, hasTestDatabase } from "../../test-utils/organization"
import { createInvoiceDraft, sendInvoice } from "../commands/invoices"
import { issueCreditNote } from "../commands/credit-notes"
import { executeCommand } from "../execute"
import { loadEinvoiceDocument } from "../../lib/exports/einvoice"
import { buildUblDocument } from "../../lib/exports/ubl"

describe.skipIf(!hasTestDatabase)("v2 credit persistence", () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => { while (cleanups.length) await cleanups.pop()?.() })
  async function setup(pricesIncludeTax = false) {
    const org = await createTestOrganization({ settings: { currency: "DKK", countryCode: "DK", pricesIncludeTax } })
    cleanups.push(async () => { await prisma.creditNote.deleteMany({ where: { organizationId: org.organizationId } }); await org.cleanup() })
    await prisma.organizationTaxId.create({ data: { organizationId: org.organizationId, scheme: "cvr", value: "12345678", countryCode: "DK", isPrimary: true } })
    const contact = await prisma.contact.create({ data: { organizationId: org.organizationId, name: "Buyer", country: "DK", email: "buyer@synthetic.test" } })
    const actor = org.actors.admin
    const created = await executeCommand(createInvoiceDraft, { contactId: contact.id, dueDate: "2026-12-01", taxRate: 25,
      items: Array.from({ length: pricesIncludeTax ? 2 : 3 }, () => ({ description: "Tiny line", quantity: "1", unitPrice: pricesIncludeTax ? "0.01" : "0.02" })),
    }, { actor })
    if (created.status !== "completed") throw new Error(JSON.stringify(created))
    const sent = await executeCommand(sendInvoice, { id: created.result.id, allowSendWithoutEmail: true }, { actor })
    if (sent.status !== "completed") throw new Error(JSON.stringify(sent))
    return { org, actor, invoice: created.result }
  }
  it("persists cumulative residuals, null valuation, copied version and frozen credit UBL", async () => {
    const { org, actor, invoice } = await setup()
    for (const [index, amount] of [0.02, 0.02, 0.03, 0.01].entries()) {
      const issued = await executeCommand(issueCreditNote, { invoiceId: invoice.id, mode: "amount", amount, reason: "Credit" }, { actor })
      if (issued.status !== "completed") throw new Error(JSON.stringify(issued))
      const persisted = await prisma.creditNote.findUniqueOrThrow({ where: { id: issued.result.id } })
      const groups = creditedGroupsSchema.parse(persisted.creditedGroups)
      expect(persisted.calculationVersion).toBe("v2")
      expect(groups[0]!.creditedTax).toBe(["0.01", "0.00", "0.01", "0.00"][index])
      expect(groups[0]!.netBase).toBeNull()
      const exportDocument = await loadEinvoiceDocument(org.organizationId, "creditNote", persisted.id)
      expect(exportDocument.frozenGroups![0]!.tax).toBe(groups[0]!.creditedTax)
      expect(buildUblDocument(exportDocument)).toContain(`<cbc:TaxAmount currencyID="DKK">${groups[0]!.creditedTax}</cbc:TaxAmount>`)
    }
    const refused = await executeCommand(issueCreditNote, { invoiceId: invoice.id, mode: "amount", amount: 0.01, reason: "Excess" }, { actor })
    expect(refused.status === "failed" && refused.error.code).toBe("fully_credited")
    expect(await prisma.creditNote.count({ where: { invoiceId: invoice.id } })).toBe(4)
  })
  it("fully reverses inclusive rounding and persists exact selected line components", async () => {
    const { actor, invoice } = await setup(true)
    const issued = await executeCommand(issueCreditNote, { invoiceId: invoice.id, mode: "full", reason: "Cancel" }, { actor })
    if (issued.status !== "completed") throw new Error(JSON.stringify(issued))
    expect(issued.result.payableRounding.toString()).toBe("-0.01")
    expect(issued.result.items.map((line) => [line.lineNet.toString(), line.lineTax.toString(), line.lineGross.toString()])).toEqual(
      invoice.items.map((line) => [line.lineNet.toString(), line.lineTax.toString(), line.lineGross.toString()]))
    expect(creditedGroupsSchema.parse(issued.result.creditedGroups)[0]!).toMatchObject({ remainingGross: "0.00", remainingNet: "0.00", remainingTax: "0.00", remainingRounding: "0.00" })
  })
  it("serializes concurrent group credits under the invoice row lock", async () => {
    const { actor, invoice } = await setup()
    const outcomes = await Promise.all(Array.from({ length: 3 }, () => executeCommand(issueCreditNote, { invoiceId: invoice.id, mode: "amount", amount: 0.04, reason: "Concurrent" }, { actor })))
    expect(outcomes.filter((outcome) => outcome.status === "completed")).toHaveLength(2)
    expect(outcomes.filter((outcome) => outcome.status === "failed")).toHaveLength(1)
    const rows = await prisma.creditNote.findMany({ where: { invoiceId: invoice.id } })
    expect(rows.reduce((sum, row) => sum + row.totalGross.toNumber(), 0)).toBe(0.08)
    expect(rows.reduce((sum, row) => sum + row.totalTax.toNumber(), 0)).toBe(0.02)
  })
})
