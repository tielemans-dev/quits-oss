import { afterEach, describe, expect, it } from "vitest"
import { createTestOrganization, hasTestDatabase } from "../../test-utils/organization"
import { prisma } from "../../lib/db"
import { appRouter } from "../../trpc/router"
import { createContact } from "../commands/contacts"
import { createInvoiceDraft, updateInvoiceDraft } from "../commands/invoices"
import { createQuoteDraft } from "../commands/quotes"
import { createAgreementDraft } from "../commands/agreements"
import { executeCommand } from "../execute"
import { CurrencyPrecisionUnsupported } from "@quits/shared/currency"
import { TRPCError } from "@trpc/server"

describe.runIf(hasTestDatabase)("currency precision creation boundaries", () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => { while (cleanups.length) await cleanups.pop()?.() })
  async function setup(currency = "USD") {
    const org = await createTestOrganization({ settings: { currency } })
    cleanups.push(org.cleanup)
    const contact = await executeCommand(createContact, { name: "Buyer" }, { actor: org.actors.admin })
    if (contact.status !== "completed") throw new Error("contact setup failed")
    const actor = org.actors.admin
    const caller = appRouter.createCaller({ session: { user: { id: actor.userId, email: "buyer@example.com", name: "User" }, session: { activeOrganizationId: org.organizationId } } } as never)
    return { org, actor, caller, contactId: contact.result.id }
  }
  const items = [{ description: "Work", quantity: 0.5, unitPrice: 100 }]
  it("refuses unsupported explicit and default currencies with a typed command error on each draft command", async () => {
    const { actor, contactId, org } = await setup("KWD")
    for (const currency of [undefined, "BHD", "JOD", "OMR", "TND", "XXX"]) {
      const outcomes = [
        await executeCommand(createInvoiceDraft, { contactId, dueDate: "2026-10-31", taxRate: 0, items, currency }, { actor }),
        await executeCommand(createQuoteDraft, { contactId, expiryDate: "2026-10-31", taxRate: 0, items, currency }, { actor }),
        await executeCommand(createAgreementDraft, { contactId, title: "Work", validUntil: "2026-10-31", currency }, { actor }),
      ]
      for (const outcome of outcomes) expect(outcome).toMatchObject({ status: "failed", error: { tag: "InvalidState", code: "currency_precision_unsupported" } })
    }
    expect(await prisma.invoice.count({ where: { organizationId: org.organizationId } })).toBe(0)
    expect(await prisma.quote.count({ where: { organizationId: org.organizationId } })).toBe(0)
    expect(await prisma.agreement.count({ where: { organizationId: org.organizationId } })).toBe(0)
  })
  it("creates supported drafts on v2 with numeric compatibility input metadata", async () => {
    const { actor, contactId } = await setup()
    const outcome = await executeCommand(createInvoiceDraft, { contactId, dueDate: "2026-10-31", taxRate: 25, items }, { actor })
    if (outcome.status !== "completed") throw new Error(JSON.stringify(outcome))
    expect(outcome.result.calculationVersion).toBe("v2")
    expect(outcome.result.totalGross.toString()).toBe("62.5")
    expect(outcome.result.items[0]).toMatchObject({ vatTreatment: "standard", quantityInput: "0.5", unitPriceInput: "100", inputPrecision: "number" })
  })
  it("refuses both settings currency setters without changing an unsupported legacy currency or its existing documents", async () => {
    const { actor, contactId, caller, org } = await setup()
    const outcome = await executeCommand(createInvoiceDraft, { contactId, dueDate: "2026-10-31", taxRate: 25, items }, { actor })
    if (outcome.status !== "completed") throw new Error("draft setup failed")
    await prisma.invoice.update({ where: { id: outcome.result.id }, data: { currency: "KWD" } })
    await prisma.orgSettings.update({ where: { organizationId: org.organizationId }, data: { currency: "KWD", defaultCurrency: "KWD" } })
    for (const field of ["currency", "defaultCurrency"]) {
      for (const currency of ["KWD", "XXX"]) {
        const error = await caller.settings.update({ [field]: currency }).catch((error: unknown) => error)
        expect(error).toBeInstanceOf(TRPCError)
        expect(error).toMatchObject({ code: "BAD_REQUEST", message: "currency_precision_unsupported", cause: expect.any(CurrencyPrecisionUnsupported) })
      }
    }
    await caller.settings.update({ companyName: "Updated seller" })
    const updated = await executeCommand(updateInvoiceDraft, { id: outcome.result.id, notes: "Updated notes" }, { actor })
    expect(updated).toMatchObject({ status: "failed", error: { code: "currency_precision_unsupported" } })
    const stored = await prisma.invoice.findUniqueOrThrow({ where: { id: outcome.result.id } })
    expect(stored.totalGross.toString()).toBe("62.5")
    expect((await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: org.organizationId } })).defaultCurrency).toBe("KWD")
    await caller.settings.update({ currency: "JPY", defaultCurrency: "JPY" })
    expect((await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: org.organizationId } })).currency).toBe("JPY")
  })
})
