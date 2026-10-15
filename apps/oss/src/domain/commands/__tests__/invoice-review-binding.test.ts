// MOCK: synthetic transactional reads and writes; the review fingerprints and the commands are real.
import { describe, expect, it, vi } from "vitest"
import { Effect } from "effect"
import type { Prisma } from "../../../../generated/prisma/client"
import { Command, Db, type CommandScope } from "../../services"
import { buildInvoiceDraft } from "../invoices"
import { updateLinkedInvoice } from "../../agreements/linked-invoice"
import { invoiceSendReviewVersion, recipientReviewVersion } from "../../approval-contexts"

const contact = { id: "synthetic-buyer", name: "Buyer", email: "buyer@example.test", company: null, address: null, city: null, zip: null, state: null, country: "DK", taxId: null, taxIds: [{ scheme: "VAT", value: "DK12345678", countryCode: "DK" }] }
const command = (): CommandScope => ({
  organizationId: "synthetic-org", commandId: "synthetic-command",
  actor: { kind: "user", organizationId: "synthetic-org", userId: "synthetic-user", roles: ["admin"], label: "User" },
  now: new Date("2026-10-14"), approvedByUserId: null, emit: vi.fn(), enqueue: vi.fn(),
})
const run = <A, E>(effect: Effect.Effect<A, E, Db | Command>, db: unknown, scope = command()) =>
  Effect.runPromise(Effect.either(effect.pipe(Effect.provideService(Db, db as Prisma.TransactionClient), Effect.provideService(Command, scope))))

describe("send confirmation bindings", () => {
  it("refuses draft creation when the contact changed since the recipient was confirmed", async () => {
    const reviewedRecipient = recipientReviewVersion(contact)
    const create = vi.fn()
    const db = { contact: { findFirst: vi.fn(async () => ({ ...contact, email: "changed@example.test" })) }, invoice: { create } }
    const result = await run(buildInvoiceDraft({ contactId: contact.id, dueDate: "2099-01-01", taxRate: 0, items: [], reviewedRecipient } as never), db)
    expect(result).toMatchObject({ _tag: "Left", left: { code: "changed_since_review" } })
    expect(create).not.toHaveBeenCalled()
  })

  it("returns a review version for linked-draft edits that matches the stored draft", async () => {
    const invoice = { id: "synthetic-invoice", agreementId: "synthetic-agreement", contactId: contact.id, items: [] }
    const updated = {
      id: invoice.id, contactId: contact.id, currency: "DKK", issueDate: new Date("2026-10-01"), dueDate: new Date("2099-01-01"), supplyDate: null,
      subtotalNet: "100", totalTax: "25", totalGross: "125", notes: null, items: [], buyerSnapshot: null, contact,
    }
    const db = {
      $queryRaw: vi.fn(async () => []),
      agreement: { findFirst: vi.fn(async () => ({ id: "synthetic-agreement", taxRate: "0", taxRateInput: "0", currency: "DKK", pricesIncludeTax: false })) },
      invoiceItem: { deleteMany: vi.fn(), createMany: vi.fn(), update: vi.fn() },
      invoice: { update: vi.fn(async (args: { include: { contact: unknown } }) => {
        expect(args.include.contact).toEqual({ include: { taxIds: true } })
        return updated
      }) },
    }
    const result = await run(updateLinkedInvoice(invoice as never, { id: invoice.id, notes: "n" } as never), db)
    expect(result).toMatchObject({ _tag: "Right", right: { reviewedVersion: invoiceSendReviewVersion(updated as never) } })
  })
})
