// MOCK: synthetic draft and transactional reads; the send command and review comparison are real.
import { describe, expect, it, vi } from "vitest"
import { Effect } from "effect"
import type { Prisma } from "../../../../generated/prisma/client"
import { Command, Db, type CommandScope } from "../../services"
import { sendInvoice } from "../invoices"
import { invoiceSendReviewVersion, recipientReviewVersion, requireReviewedRecipient, requireInvoiceSendReview } from "../../approval-contexts"

describe("invoice send confirmation", () => {
  it("accepts reordered tax IDs but rejects changed tax identity in both review versions", async () => {
    const contact = {
      name: "Synthetic buyer", email: "buyer@example.test", company: null, address: null,
      city: null, zip: null, state: null, country: "DK",
      taxIds: [{ scheme: "VAT", value: "DK12345678", countryCode: "DK" }, { scheme: "cvr", value: "12345678", countryCode: "DK" }],
    }
    const invoice = {
      number: null, contactId: "synthetic-buyer", currency: "DKK", issueDate: new Date("2026-10-01"),
      dueDate: new Date("2099-01-01"), supplyDate: null, subtotalNet: "200", totalTax: "50", totalGross: "250",
      notes: null, items: [], buyerSnapshot: null, contact,
    }
    const reviewedRecipient = recipientReviewVersion(contact)
    const reviewedVersion = invoiceSendReviewVersion(invoice, null)
    const originalOrder = [...contact.taxIds]
    contact.taxIds = [...originalOrder].reverse()
    expect(recipientReviewVersion(contact)).toBe(reviewedRecipient)
    expect(invoiceSendReviewVersion(invoice, null)).toBe(reviewedVersion)
    expect(contact.taxIds).toEqual([...originalOrder].reverse())
    await expect(Effect.runPromise(requireReviewedRecipient(contact, reviewedRecipient))).resolves.toBeUndefined()
    await expect(Effect.runPromise(requireInvoiceSendReview(invoice, null, reviewedVersion))).resolves.toBeUndefined()
    contact.taxIds[0]!.value = "87654321"
    expect(recipientReviewVersion(contact)).not.toBe(reviewedRecipient)
    expect(invoiceSendReviewVersion(invoice, null)).not.toBe(reviewedVersion)
    expect(await Effect.runPromise(Effect.either(requireReviewedRecipient(contact, reviewedRecipient)))).toMatchObject({ _tag: "Left", left: { code: "changed_since_review" } })
    expect(await Effect.runPromise(Effect.either(requireInvoiceSendReview(invoice, null, reviewedVersion)))).toMatchObject({ _tag: "Left", left: { code: "changed_since_review" } })
  })
  it("binds the review version to the payment details a send would freeze", () => {
    const invoice = {
      number: null, contactId: "synthetic-buyer", currency: "DKK", issueDate: new Date("2026-10-01"),
      dueDate: new Date("2099-01-01"), supplyDate: null, subtotalNet: "200", totalTax: "50", totalGross: "250",
      notes: null, items: [], buyerSnapshot: null,
      contact: { name: "Buyer", email: "buyer@example.test", company: null, address: null, city: null, zip: null, state: null, country: "DK", taxIds: [] },
    }
    const bank = { bankRegNumber: "0040", bankAccountNumber: "0440116243" }
    const reviewed = invoiceSendReviewVersion(invoice, bank)
    expect(invoiceSendReviewVersion(invoice, { ...bank, bankName: null, bankIban: null })).toBe(reviewed)
    expect(invoiceSendReviewVersion(invoice, null)).not.toBe(reviewed)
    expect(invoiceSendReviewVersion(invoice, { ...bank, bankAccountNumber: "0440116244" })).not.toBe(reviewed)
    expect(invoiceSendReviewVersion(invoice, { ...bank, paymentNote: "Pay within 8 days" })).not.toBe(reviewed)
  })
  it.each(["amount", "recipient", "due date", "payment details"])("refuses a changed %s before updating or queuing anything", async change => {
    const invoice = {
      id: "synthetic-invoice", status: "draft", number: null, contactId: "synthetic-buyer",
      currency: "DKK", issueDate: new Date("2026-10-01"), dueDate: new Date("2099-01-01"), supplyDate: null,
      subtotalNet: "200", totalTax: "50", totalGross: "250", notes: null, items: [], buyerSnapshot: null,
      contact: { name: "Original buyer", email: "buyer@example.test", company: null, address: null, city: null, zip: null, state: null, country: "DK" },
      lastEmailAttemptOutcome: null,
    }
    const reviewedVersion = invoiceSendReviewVersion(invoice, null)
    await expect(Effect.runPromise(requireInvoiceSendReview(invoice, null, reviewedVersion))).resolves.toBeUndefined()
    if (change === "amount") invoice.totalGross = "500"
    if (change === "recipient") invoice.contact.email = "changed@example.test"
    if (change === "due date") invoice.dueDate = new Date("2099-02-01")
    // Settings changed after the review: the send would freeze a bank account the person never saw.
    const settings = change === "payment details" ? { countryCode: "DK", bankRegNumber: "0040", bankAccountNumber: "0440116243" } : { countryCode: "DK" }
    const update = vi.fn()
    const db = {
      $queryRaw: vi.fn(async () => []), invoice: { findFirst: vi.fn(async () => invoice), update },
      contact: { findFirstOrThrow: vi.fn(async () => invoice.contact) },
      orgSettings: { upsert: vi.fn(async () => settings) },
      organizationTaxId: { findMany: vi.fn(async () => []) },
    }
    const command: CommandScope = {
      organizationId: "synthetic-org", commandId: "synthetic-command",
      actor: { kind: "user", organizationId: "synthetic-org", userId: "synthetic-user", roles: ["admin"], label: "User" },
      now: new Date("2026-10-14"), approvedByUserId: null, emit: vi.fn(), enqueue: vi.fn(),
    }
    const result = await Effect.runPromise(Effect.either(sendInvoice.handle({
      id: invoice.id, reviewedVersion,
    }).pipe(Effect.provideService(Db, db as unknown as Prisma.TransactionClient), Effect.provideService(Command, command))))
    expect(result).toMatchObject({ _tag: "Left", left: { code: "changed_since_review" } })
    expect(update).not.toHaveBeenCalled()
    expect(command.emit).not.toHaveBeenCalled()
    expect(command.enqueue).not.toHaveBeenCalled()
  })
})
