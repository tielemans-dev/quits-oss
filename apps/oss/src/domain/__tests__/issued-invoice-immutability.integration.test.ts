import { afterEach, describe, expect, it } from "vitest"
import { prisma } from "../../lib/db"
import { createTestOrganization, hasTestDatabase } from "../../test-utils/organization"
import { createContact } from "../commands/contacts"
import { createInvoiceDraft, updateInvoiceDraft } from "../commands/invoices"
import { executeCommand, type CommandOutcome } from "../execute"

function completed<T>(outcome: CommandOutcome<T>): T {
  expect(outcome.status).toBe("completed")
  if (outcome.status !== "completed") throw new Error(JSON.stringify(outcome))
  return outcome.result
}

/**
 * Every customer-facing amount (email, public page, Stripe checkout, reminders, payments) reads the
 * invoice row, so an issued row's totals and lines must never change through a draft editor.
 */
describe.runIf(hasTestDatabase)("issued invoice amounts are immutable", () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.()
  })

  async function money(id: string) {
    const row = await prisma.invoice.findUniqueOrThrow({ where: { id }, include: { items: { orderBy: { sortOrder: "asc" } } } })
    return {
      subtotalNet: row.subtotalNet.toString(), totalTax: row.totalTax.toString(), totalGross: row.totalGross.toString(),
      currency: row.currency, supplyDate: row.supplyDate,
      items: row.items.map(item => [item.description, item.quantity.toString(), item.unitPriceNet.toString(), item.taxRate.toString(), item.lineGross.toString()]),
    }
  }

  it.each(["sent", "viewed", "overdue", "paid"] as const)("refuses line, currency, VAT and notes edits on a %s invoice", async (status) => {
    const org = await createTestOrganization()
    cleanups.push(org.cleanup)
    const actor = org.actors.admin
    const contact = completed(await executeCommand(createContact, { name: "Buyer" }, { actor }))
    const invoice = completed(await executeCommand(createInvoiceDraft, {
      contactId: contact.id, dueDate: "2099-12-01", items: [{ description: "Work", quantity: 2, unitPrice: 100 }],
    }, { actor }))
    await prisma.invoice.update({ where: { id: invoice.id }, data: { status, number: `INV-${status}` } })
    const before = await money(invoice.id)

    for (const change of [
      { items: [{ description: "Work", quantity: 5, unitPrice: 999 }] },
      { currency: before.currency === "EUR" ? "USD" : "EUR" },
      { taxRate: 0.5 },
      { notes: "late edit" },
      { supplyDate: "2026-10-07" },
      { supplyDate: null },
    ]) {
      expect(await executeCommand(updateInvoiceDraft, { id: invoice.id, ...change }, { actor }))
        .toMatchObject({ status: "failed", error: { code: "not_draft" } })
    }
    expect(await money(invoice.id)).toEqual(before)
  })
})
