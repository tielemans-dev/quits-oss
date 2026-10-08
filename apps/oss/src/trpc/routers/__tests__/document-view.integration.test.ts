import { randomUUID } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { documentViewSchema } from "@quits/contracts/document-view"
import { buildIssuedView } from "@quits/shared/documents"
import { Prisma } from "../../../../generated/prisma/client"
import { prisma } from "../../../lib/db"
import { createTestOrganization, hasTestDatabase } from "../../../test-utils/organization"
import { invoiceIssuedSchema } from "../../../domain/events/money"
import { appRouter } from "../../router"

const moneySnapshotSchema = invoiceIssuedSchema.omit({ artifacts: true }).extend({
  provenance: invoiceIssuedSchema.shape.provenance.omit({ candidateId: true, commandId: true }),
})

const cleanups: Array<() => Promise<void>> = []
beforeEach(() => { vi.stubEnv("RESEND_API_KEY", "") })
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.()
  vi.unstubAllEnvs()
})
function caller(organizationId: string, userId: string) {
  return appRouter.createCaller({ session: {
    user: { id: userId, email: "test@example.test", name: "Test" }, session: { activeOrganizationId: organizationId },
  } } as never)
}
async function setup(currency = "USD", timezone = "UTC") {
  const org = await createTestOrganization({ roles: ["admin", "accountant"], settings: { currency, timezone } })
  cleanups.push(org.cleanup)
  const admin = caller(org.organizationId, org.actors.admin.userId)
  const accountant = caller(org.organizationId, org.actors.accountant.userId)
  const contact = await prisma.contact.create({ data: { organizationId: org.organizationId, name: "Original buyer", email: "buyer@example.test" } })
  const input = { contactId: contact.id, taxRate: "25", items: [
    { key: "work", description: "Work", quantity: "3", unitPrice: "33.33" },
    { key: "fee", description: "Fee", quantity: "1", unitPrice: "10" },
  ] }
  const invoice = await admin.invoices.createV2({ ...input, dueDate: "2099-01-01", supplyDate: "2026-10-08" })
  const quote = await admin.quotes.createV2({ ...input, expiryDate: "2099-01-01" })
  return { org, admin, accountant, contact, invoice, quote }
}

type Context = Awaited<ReturnType<typeof setup>>
async function issue(ctx: Context) {
  await ctx.admin.invoices.send({ id: ctx.invoice.id, allowSendWithoutEmail: true })
  return prisma.invoice.findUniqueOrThrow({ where: { id: ctx.invoice.id }, include: { items: true } })
}

;(hasTestDatabase ? describe : describe.skip)("server document views and draft revisions", () => {
  it("keeps issued payable frozen while receipt allocations and reversals update status and balance", async () => {
    const ctx = await setup("DKK")
    const id = ctx.invoice.id
    await ctx.admin.invoices.updateV2({ id, items: [{ key: "work", description: "Work", quantity: "1", unitPrice: "800" }] })
    const issued = await issue(ctx)
    const before = await ctx.admin.invoices.view({ id })
    expect(before.view.totals).toMatchObject({ gross: "1000.00", payable: "1000.00" })
    const evidence = { reason: "Bank statement reconciled", evidence: "https://evidence.example.test/statement" }
    const { receiptId } = await ctx.admin.payments.recordReceipt({
      requestId: randomUUID(), reference: randomUUID(), contactId: ctx.contact.id, currency: "DKK",
      netAmount: "985", feeAmount: "15", feeEvidence: evidence, paidAt: "2026-10-08", method: "bank_transfer", ...evidence,
    })
    const expectSettlement = async (status: string, amountPaid: number, balanceDue: number) => {
      // Status is current; the rendered money, line keys and draft revision remain as issued.
      expect(await ctx.admin.invoices.view({ id })).toEqual({ ...before, view: { ...before.view, status } })
      expect(await ctx.admin.invoices.get({ id })).toMatchObject({ status, amountPaid, balanceDue })
      expect(await ctx.admin.payments.list({ invoiceId: id })).toMatchObject({ amountPaid, balanceDue })
      expect((await prisma.invoice.findUniqueOrThrow({ where: { id } })).issuanceSnapshot).toEqual(issued.issuanceSnapshot)
    }
    // Unallocated receipt funds do not discharge this invoice's debt.
    await expectSettlement("sent", 0, 1000)
    const allocate = async (amount: string) => {
      const input = { requestId: randomUUID(), receiptId, allocations: [{ invoiceId: id, receiptAmount: amount, invoiceAmount: amount }], ...evidence }
      const { previewToken } = await ctx.admin.payments.previewAllocation(input)
      return ctx.admin.payments.allocateReceipt({ ...input, previewToken })
    }
    const first = await allocate("600")
    await expectSettlement("sent", 600, 400)
    await allocate("400")
    // The evidenced gross allocation settles 1000, despite the net bank receipt being 985.
    await expectSettlement("paid", 1000, 0)
    const correction = { requestId: randomUUID(), action: "reverse_allocation" as const, paymentId: first.paymentIds[0]!, ...evidence }
    const { previewToken } = await ctx.admin.payments.previewReceiptChange(correction)
    await ctx.admin.payments.changeReceipt({ ...correction, previewToken })
    await expectSettlement("sent", 400, 600)
    const payments = await ctx.admin.payments.list({ invoiceId: id })
    expect(payments.payments).toHaveLength(2)
    expect(payments.payments.every(payment => payment.receiptId === receiptId)).toBe(true)
    expect(payments.payments.find(payment => payment.id === first.paymentIds[0])?.voidedAt).toBeInstanceOf(Date)
  })

  for (const timezone of ["America/New_York", "Pacific/Auckland"]) {
    it(`round-trips calendar dates without timezone drift in ${timezone}`, async () => {
      const ctx = await setup("USD", timezone)
      const date = "2026-11-07"
      await ctx.admin.invoices.update({ id: ctx.invoice.id, dueDate: date, supplyDate: date })
      await ctx.admin.quotes.update({ id: ctx.quote.id, expiryDate: date })
      expect((await prisma.invoice.findUniqueOrThrow({ where: { id: ctx.invoice.id } })).dueDate.toISOString()).toBe(`${date}T00:00:00.000Z`)
      expect((await prisma.quote.findUniqueOrThrow({ where: { id: ctx.quote.id } })).expiryDate.toISOString()).toBe(`${date}T00:00:00.000Z`)
      for (let round = 0; round < 2; round++) {
        const invoice = await ctx.admin.invoices.view({ id: ctx.invoice.id })
        const quote = await ctx.admin.quotes.view({ id: ctx.quote.id })
        expect(invoice.view.dates).toMatchObject({ dueDate: date, supplyDate: date, issueDate: null })
        expect(quote.view.dates.expiryDate).toBe(date)
        await ctx.admin.invoices.update({ id: ctx.invoice.id, dueDate: invoice.view.dates.dueDate!, supplyDate: invoice.view.dates.supplyDate! })
        await ctx.admin.quotes.update({ id: ctx.quote.id, expiryDate: quote.view.dates.expiryDate! })
      }
      expect((await ctx.admin.invoices.view({ id: ctx.invoice.id })).view.dates.dueDate).toBe(date)
      expect((await ctx.admin.quotes.view({ id: ctx.quote.id })).view.dates.expiryDate).toBe(date)
      // Issued-row fallbacks keep calendar dates too, but issueDate remains a zoned instant.
      const issueDate = new Date("2026-11-07T00:00:00.000Z")
      await prisma.invoice.update({ where: { id: ctx.invoice.id }, data: { status: "sent", number: "INV-1", issueDate } })
      await prisma.quote.update({ where: { id: ctx.quote.id }, data: { status: "sent", number: "QTE-1", issueDate } })
      const issuedDay = timezone === "America/New_York" ? "2026-11-06" : date
      expect((await ctx.admin.invoices.view({ id: ctx.invoice.id })).view.dates).toMatchObject({ dueDate: date, issueDate: issuedDay })
      expect((await ctx.admin.quotes.view({ id: ctx.quote.id })).view.dates).toMatchObject({ expiryDate: date, issueDate: issuedDay })
    })
  }

  for (const kind of ["invoice", "quote"] as const) {
    it(`shows a notice instead of throwing for corrupt ${kind} VAT evidence`, async () => {
      const ctx = await setup()
      const id = ctx[kind].id
      const api = kind === "invoice" ? ctx.admin.invoices : ctx.admin.quotes
      const before = await api.view({ id })
      const vatEvidence = { viesCheck: { result: 123 } }
      if (kind === "invoice") await prisma.invoice.update({ where: { id }, data: { vatEvidence } })
      else await prisma.quote.update({ where: { id }, data: { vatEvidence } })
      const after = await api.view({ id })
      expect(after).toMatchObject({ historical: false, revision: before.revision, notices: ["invalid_vat_evidence"], view: { vatEvidence: null } })
      expect(after.view.totals).toEqual(before.view.totals)
      expect(after.view.lines).toEqual(before.view.lines)
      expect(documentViewSchema.parse(after.view)).toEqual(after.view)
    })

    it(`saves a ${kind} with corrupt evidence without changing VAT or clearing its notice`, async () => {
      const ctx = await setup()
      const id = ctx[kind].id
      const api = kind === "invoice" ? ctx.admin.invoices : ctx.admin.quotes
      const stored = () => kind === "invoice"
        ? prisma.invoice.findUniqueOrThrow({ where: { id } })
        : prisma.quote.findUniqueOrThrow({ where: { id } })
      const items = [
        { key: "taxed", description: "Taxed", quantity: "1", unitPrice: "100", vat: { treatment: "standard" as const, rate: "0.25" } },
        { key: "reverse", description: "Reverse charge", quantity: "1", unitPrice: "100", vat: { treatment: "intra_community" as const, rate: "0", reasonCode: "services_b2b" as const, country: "DE" } },
      ]
      const evidence = { buyerVatId: "DE123456789", statementText: "Reverse charge", viesCheck: { result: "valid" as const, at: "2026-10-07T00:00:00Z" } }
      await api.updateV2({ id, items, vatEvidence: evidence })
      const before = await api.view({ id })
      const corrupt = { viesCheck: { result: 123 } }
      if (kind === "invoice") await prisma.invoice.update({ where: { id }, data: { vatEvidence: corrupt } })
      else await prisma.quote.update({ where: { id }, data: { vatEvidence: corrupt } })

      await api.updateV2({ id, expectedRevision: before.revision, notes: "Saved despite corrupt evidence" })
      const after = await api.view({ id })
      expect(after).toMatchObject({ revision: before.revision + 1, notices: ["invalid_vat_evidence"], view: { vatEvidence: null, notes: "Saved despite corrupt evidence" } })
      expect(after.view.totals).toEqual(before.view.totals)
      expect(after.view.lines.map(line => line.vat)).toEqual(before.view.lines.map(line => line.vat))
      expect((await stored()).vatEvidence).toEqual(corrupt)
      // Saving remains possible, but issuing still requires usable evidence.
      await expect(api.send({ id, allowSendWithoutEmail: true })).rejects.toMatchObject({ cause: { code: "evidence_incomplete" } })

      await api.updateV2({ id, items: items.map(line => ({ ...line, quantity: "2" })) })
      const edited = await api.view({ id })
      expect(edited.notices).toEqual(["invalid_vat_evidence"])
      expect(edited.view.totals).toMatchObject({ net: "400.00", tax: "50.00", gross: "450.00" })
      expect(edited.view.lines.map(line => line.vat)).toEqual(before.view.lines.map(line => line.vat))
      expect((await stored()).vatEvidence).toEqual(corrupt)

      await api.updateV2({ id, vatEvidence: evidence })
      expect(await api.view({ id })).toMatchObject({ notices: [], view: { vatEvidence: evidence } })
      expect((await stored()).vatEvidence).toEqual(evidence)
      await api.updateV2({ id, notes: "Keep repaired evidence" })
      expect((await stored()).vatEvidence).toEqual(evidence)
      await api.updateV2({ id, vatEvidence: {} })
      expect(await api.view({ id })).toMatchObject({ notices: [], view: { vatEvidence: null } })
      expect((await stored()).vatEvidence).toEqual({})
    })

    it(`refuses duplicate ${kind} keys without saving and persists trimmed keys`, async () => {
      const ctx = await setup()
      const id = ctx[kind].id
      const api = kind === "invoice" ? ctx.admin.invoices : ctx.admin.quotes
      const before = await api.view({ id })
      const line = { description: "Work", quantity: "1", unitPrice: "10" }
      await expect(api.updateV2({ id, items: [{ ...line, key: "a" }, { ...line, key: " a " }] })).rejects.toMatchObject({ code: "BAD_REQUEST" })
      expect(await api.view({ id })).toEqual(before)
      await api.updateV2({ id, items: [{ ...line, key: " a " }, { ...line, key: "b" }] })
      expect((await api.view({ id })).view.lines.map(row => row.key)).toEqual(["a", "b"])
    })

    it(`refuses one of two concurrent ${kind} saves without changing its lines or emitting another event`, async () => {
      const ctx = await setup()
      const id = ctx[kind].id
      const api = kind === "invoice" ? ctx.admin.invoices : ctx.admin.quotes
      const before = await api.view({ id })
      expect(before.revision).toBe(0)
      const results = await Promise.allSettled(["a", "b"].map(key => api.updateV2({
        id, expectedRevision: before.revision, notes: key,
        items: [{ key, description: key, quantity: "1", unitPrice: "12.3456" }],
      })))
      expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1)
      expect(results.find(result => result.status === "rejected")).toMatchObject({
        reason: { code: "BAD_REQUEST", cause: { tag: "InvalidState", code: "stale_draft" } },
      })
      const after = await api.view({ id })
      expect(after.revision).toBe(1)
      expect(after.view.lines[0]?.key).toBe(after.view.notes)
      const events = await prisma.domainEvent.findMany({ where: { organizationId: ctx.org.organizationId, aggregateId: id, type: `${kind}.draft_updated` } })
      expect(events).toHaveLength(1)
      expect(events[0]?.payload).toEqual({ fields: ["notes", "items"] })
      // Old clients still save without a revision; a notes-only save preserves client keys.
      await api.update({ id, notes: "Old client" })
      const final = await api.view({ id })
      expect(final.revision).toBe(2)
      expect(final.view.lines[0]?.key).toBe(after.view.lines[0]?.key)
      expect(final.view.lines[0]?.id).not.toBe(after.view.lines[0]?.id)
    })

    it(`scopes the ${kind} view and edits to the organization and respects read-only roles and email locks`, async () => {
      const ctx = await setup()
      const id = ctx[kind].id
      const admin = kind === "invoice" ? ctx.admin.invoices : ctx.admin.quotes
      const accountant = kind === "invoice" ? ctx.accountant.invoices : ctx.accountant.quotes
      expect(await admin.view({ id })).toMatchObject({ canEdit: true, locks: { agreementLinked: false, emailSending: false }, historical: false })
      expect(await accountant.view({ id })).toMatchObject({ canEdit: false })
      await expect(accountant.update({ id, notes: "No" })).rejects.toMatchObject({ code: "FORBIDDEN" })
      const other = await setup()
      const foreign = kind === "invoice" ? other.admin.invoices : other.admin.quotes
      await expect(foreign.view({ id })).rejects.toMatchObject({ code: "NOT_FOUND" })
      await expect(foreign.update({ id, expectedRevision: 0, notes: "No" })).rejects.toMatchObject({ code: "NOT_FOUND" })
      if (kind === "invoice") await prisma.invoice.update({ where: { id }, data: { lastEmailAttemptOutcome: "sending" } })
      else await prisma.quote.update({ where: { id }, data: { lastEmailAttemptOutcome: "sending" } })
      expect(await admin.view({ id })).toMatchObject({ canEdit: false, locks: { emailSending: true } })
      await expect(admin.update({ id, notes: "No" })).rejects.toMatchObject({ cause: { code: "send_in_progress" } })
    })
  }

  it("loads frozen parties, payment details, parsed evidence and live draft branding without consuming a number", async () => {
    const ctx = await setup("JPY")
    await prisma.orgSettings.update({ where: { organizationId: ctx.org.organizationId }, data: {
      companyName: "New seller", companyPhone: "+45 12345678", companyLogo: "https://example.test/logo.png", invoicePrefix: "FAK", invoiceNextNum: 42,
    } })
    await prisma.contact.update({ where: { id: ctx.contact.id }, data: { name: "New buyer" } })
    await prisma.invoice.update({ where: { id: ctx.invoice.id }, data: {
      calculationVersion: "old_unknown", sellerSnapshot: { companyName: "Frozen seller", bankAccount: { iban: "DK5000400440116243" }, paymentNote: "Frozen note" },
      vatEvidence: { statementText: "Document evidence" },
    } })
    const result = await ctx.admin.invoices.view({ id: ctx.invoice.id })
    expect(documentViewSchema.parse(result.view)).toEqual(result.view)
    expect(result.view).toMatchObject({
      exponent: 0, number: { value: null, preview: "FAK-0042" }, dates: { issueDate: null, supplyDate: "2026-10-08", dueDate: "2099-01-01" },
      seller: { name: "Frozen seller", phone: "+45 12345678", logoUrl: "https://example.test/logo.png" }, buyer: { name: "Original buyer" },
      paymentDetails: { bankAccount: { iban: "DK5000400440116243" }, note: "Frozen note" },
      vatEvidence: { statementText: "Document evidence" }, calculation: { version: "legacy_per_line", staleLegacy: true },
    })
    expect(result.view.lines.map(line => line.key)).toEqual(["work", "fee"])
    expect(result.view.totals?.gross).toMatch(/^\d+$/)
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: ctx.invoice.id } })).calculationVersion).toBe("old_unknown")
    expect((await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: ctx.org.organizationId } })).invoiceNextNum).toBe(42)
  })

  it("serves exactly the issued snapshot with frozen branding, even after live settings and stored rows change", async () => {
    const ctx = await setup()
    await ctx.admin.paymentDetails.update({ bankAccount: { iban: "DK5000400440116243" }, note: "At issuance" })
    await prisma.orgSettings.update({ where: { organizationId: ctx.org.organizationId }, data: { companyPhone: "original phone", companyLogo: "https://example.test/original.png" } })
    const issued = await issue(ctx)
    const snapshot = moneySnapshotSchema.parse(issued.issuanceSnapshot)
    await prisma.orgSettings.update({ where: { organizationId: ctx.org.organizationId }, data: { companyName: "Changed seller", companyPhone: "new phone", companyLogo: null } })
    await prisma.invoiceItem.updateMany({ where: { invoiceId: issued.id }, data: { lineGross: 999, description: "Changed row" } })
    const result = await ctx.admin.invoices.view({ id: issued.id })
    expect(result).toMatchObject({ canEdit: false, historical: false, notices: [] })
    expect(result.view).toEqual(buildIssuedView(snapshot, {
      kind: "invoice", status: issued.status, locale: issued.locale, timezone: issued.timezone,
      contactId: issued.contactId, notes: issued.notes, paymentReference: issued.paymentReference,
      sellerPhone: "original phone", logoUrl: "https://example.test/original.png",
    }))
  })

  for (const corruption of ["missing", "sparse", "invalid_amount", "nested_null"] as const) {
    it(`falls back to historical stored amounts for a ${corruption} snapshot`, async () => {
      const ctx = await setup()
      const issued = await issue(ctx)
      const valid = moneySnapshotSchema.parse(issued.issuanceSnapshot)
      const snapshot = corruption === "missing" ? Prisma.DbNull : corruption === "sparse" ? { number: issued.number } : corruption === "invalid_amount"
        ? { ...valid, totals: { ...valid.totals, gross: "corrupt" } }
        : { ...valid, lines: [{ ...valid.lines[0], vat: null }] }
      await prisma.invoice.update({ where: { id: issued.id }, data: { issuanceSnapshot: snapshot } })
      const result = await ctx.admin.invoices.view({ id: issued.id })
      expect(result).toMatchObject({ historical: true, canEdit: false, view: { state: "issued" } })
      expect(documentViewSchema.parse(result.view)).toEqual(result.view)
      expect(result.view.totals).toMatchObject({ net: issued.subtotalNet.toFixed(2), tax: issued.totalTax.toFixed(2), gross: issued.totalGross.toFixed(2) })
      expect(result.view.lines.map(line => line.gross)).toEqual(issued.items.map(line => line.lineGross.toFixed(2)))
      expect(result.view.lines.every(line => line.locked)).toBe(true)
    })
  }

  it("locks the stored rows of sent, accepted and rejected quotes without labelling them historical", async () => {
    const ctx = await setup()
    const before = (await ctx.admin.quotes.view({ id: ctx.quote.id })).view
    await ctx.admin.quotes.send({ id: ctx.quote.id, allowSendWithoutEmail: true })
    for (const status of ["sent", "accepted", "rejected"]) {
      await prisma.quote.update({ where: { id: ctx.quote.id }, data: { status } })
      const result = await ctx.admin.quotes.view({ id: ctx.quote.id })
      expect(result).toMatchObject({ canEdit: false, historical: false, view: { kind: "quote", state: "issued", status, calculation: { staleLegacy: false } } })
      expect(result.view.lines.every(line => line.locked)).toBe(true)
      expect(result.view.totals).toEqual(before.totals)
      expect(result.view.number).toEqual({ value: "QTE-0001", preview: null })
    }
  })

  it("preserves client keys through linked reordering, notes-only edits, and adding deliverables", async () => {
    const ctx = await setup()
    const agreement = await ctx.admin.agreements.createDraft({
      contactId: ctx.contact.id, title: "Project", validUntil: "2099-01-01", taxRate: "25",
      deliverables: [{ title: "First", quantity: "1", unitPrice: "100" }, { title: "Second", quantity: "1", unitPrice: "200" }],
    })
    // State setup only; invoice creation and all subsequent saves go through the real writers.
    await prisma.agreement.update({ where: { id: agreement.id }, data: { status: "accepted" } })
    await prisma.deliverable.updateMany({ where: { agreementId: agreement.id }, data: { status: "accepted" } })
    const created = await ctx.admin.invoices.createFromDeliverables({ agreementId: agreement.id, deliverableIds: [agreement.deliverables[0]!.id] })
    const id = created.saleInvoiceId!
    const before = await ctx.admin.invoices.view({ id })
    expect(before).toMatchObject({ revision: 0, canEdit: true, locks: { agreementLinked: true } })
    expect(before.view.lines[0]?.key).toBe(agreement.deliverables[0]!.id)
    const linked = before.view.lines[0]!
    const linkedInput = { id: linked.id!, description: linked.description, quantity: linked.quantity, unitPrice: linked.unitPrice }
    // Only the extra supplies a key. It must not collide with an inherited linked key or id.
    for (const key of [linked.key, linked.id!]) {
      await prisma.invoiceItem.update({ where: { id: linked.id! }, data: { clientKey: key === linked.id ? null : linked.key } })
      await expect(ctx.admin.invoices.updateV2({ id, items: [
        linkedInput, { key, description: "Collision", quantity: "1", unitPrice: "10" },
      ] })).rejects.toMatchObject({ cause: { code: "duplicate_line_key" } })
      expect((await ctx.admin.invoices.view({ id })).revision).toBe(0)
    }

    await ctx.admin.invoices.updateV2({ id, expectedRevision: 0, items: [
      { key: "extra-first", description: "Extra first", quantity: "2", unitPrice: "10" },
      { id: linked.id!, key: "linked-key", description: linked.description, quantity: linked.quantity, unitPrice: linked.unitPrice },
      { key: "extra-last", description: "Extra last", quantity: "1", unitPrice: "20" },
    ] })
    const after = await ctx.admin.invoices.view({ id })
    expect(after.revision).toBe(1)
    // A renamed linked row must also be checked against an extra's inherited client key.
    const extra = after.view.lines[1]!
    await expect(ctx.admin.invoices.updateV2({ id, items: [
      { ...linkedInput, key: extra.key },
      { id: extra.id!, description: extra.description, quantity: extra.quantity, unitPrice: extra.unitPrice },
    ] })).rejects.toMatchObject({ cause: { code: "duplicate_line_key" } })
    expect(await ctx.admin.invoices.view({ id })).toEqual(after)
    expect(after.view.lines.map(line => [line.description, line.key, line.locked])).toEqual([
      [linked.description, "linked-key", true], ["Extra first", "extra-first", false], ["Extra last", "extra-last", false],
    ])
    await ctx.admin.invoices.updateV2({ id, expectedRevision: 1, items: after.view.lines.slice().reverse().map(line => ({
      id: line.id!, key: line.key, description: line.description, quantity: line.quantity, unitPrice: line.unitPrice,
    })) })
    const reordered = await ctx.admin.invoices.view({ id })
    expect(reordered.view.lines.map(line => line.key)).toEqual(["linked-key", "extra-last", "extra-first"])
    expect(reordered.view.lines[0]?.id).toBe(linked.id)
    expect(reordered.view.lines[1]?.id).not.toBe(after.view.lines[2]?.id)
    await ctx.admin.invoices.update({ id, expectedRevision: 2, notes: "Keep keys" })
    await expect(ctx.admin.invoices.addDeliverables({ id, expectedRevision: 2, agreementId: agreement.id, deliverableIds: [agreement.deliverables[1]!.id] })).rejects.toMatchObject({ cause: { code: "stale_draft" } })
    await ctx.admin.invoices.addDeliverables({ id, expectedRevision: 3, agreementId: agreement.id, deliverableIds: [agreement.deliverables[1]!.id] })
    const final = await ctx.admin.invoices.view({ id })
    expect(final.revision).toBe(4)
    expect(final.view.lines.map(line => line.key)).toEqual(["linked-key", "extra-last", "extra-first", agreement.deliverables[1]!.id])
    await expect(ctx.admin.invoices.update({ id, expectedRevision: 3, notes: "Stale" })).rejects.toMatchObject({ cause: { code: "stale_draft" } })
  })

  it("copies quote keys into a converted draft invoice", async () => {
    const ctx = await setup()
    await ctx.admin.quotes.send({ id: ctx.quote.id, allowSendWithoutEmail: true })
    await prisma.quote.update({ where: { id: ctx.quote.id }, data: { status: "accepted" } })
    const invoice = await ctx.admin.quotes.convertToInvoice({ id: ctx.quote.id })
    const result = await ctx.admin.invoices.view({ id: invoice.id })
    expect(result.revision).toBe(0)
    expect(result.view.lines.map(line => line.key)).toEqual(["work", "fee"])
  })

  it("checks and increments the revision when a prepayment draft becomes a sale", async () => {
    const ctx = await setup()
    const agreement = await ctx.admin.agreements.createDraft({
      contactId: ctx.contact.id, title: "Deposit", validUntil: "2099-01-01", taxRate: "25",
      deliverables: [{ title: "Deposit", quantity: "1", unitPrice: "100", isDeposit: true }],
    })
    await prisma.agreement.update({ where: { id: agreement.id }, data: { status: "accepted" } })
    const created = await ctx.admin.invoices.createFromDeliverables({ agreementId: agreement.id, deliverableIds: [agreement.deliverables[0]!.id] })
    const id = created.prepaymentInvoiceId!
    await expect(ctx.admin.invoices.scheduleAsSale({ id, confirmed: true, expectedRevision: 1 })).rejects.toMatchObject({ cause: { code: "stale_draft" } })
    expect((await ctx.admin.invoices.view({ id })).revision).toBe(0)
    await ctx.admin.invoices.scheduleAsSale({ id, confirmed: true, expectedRevision: 0 })
    expect((await ctx.admin.invoices.view({ id })).revision).toBe(1)
  })

  it("takes a credit note's correction date from the invoice snapshot and falls back for sparse historical credit notes", async () => {
    const ctx = await setup()
    const invoice = await issue(ctx)
    const snapshot = moneySnapshotSchema.parse(invoice.issuanceSnapshot)
    const credit = await ctx.admin.creditNotes.issue({ invoiceId: invoice.id, mode: "full", reason: "Correction" })
    await prisma.invoice.update({ where: { id: invoice.id }, data: { issueDate: new Date("1999-01-01") } })
    const result = await ctx.admin.creditNotes.view({ id: credit.id })
    expect(result).toMatchObject({ historical: false, canEdit: false, view: {
      kind: "creditNote", correction: { invoiceNumber: invoice.number, invoiceIssueDate: snapshot.issueDate, reason: "Correction" }, paymentDetails: null,
    } })
    await prisma.creditNote.update({ where: { id: credit.id }, data: { issuanceSnapshot: { number: credit.number, totalGross: 0 } } })
    const historical = await ctx.admin.creditNotes.view({ id: credit.id })
    expect(historical.historical).toBe(true)
    expect(historical.view.totals?.gross).toBe(invoice.totalGross.toFixed(2))
    expect(historical.view.correction).toEqual(result.view.correction)
    await prisma.invoice.update({ where: { id: invoice.id }, data: { issuanceSnapshot: Prisma.DbNull } })
    expect((await ctx.admin.creditNotes.view({ id: credit.id })).view.correction?.invoiceIssueDate).toBeNull()
    const other = await setup()
    await expect(other.admin.creditNotes.view({ id: credit.id })).rejects.toMatchObject({ code: "NOT_FOUND" })
  })
})
