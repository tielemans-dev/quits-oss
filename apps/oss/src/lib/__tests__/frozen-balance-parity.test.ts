import { beforeEach, describe, expect, it, vi } from "vitest"
import { Prisma } from "../../../generated/prisma/client"
import fixture from "../../domain/events/__tests__/fixtures/invoice.issued.v1.json"

// MOCK: synthetic invoice row, Stripe and database seams, confined to this test.
const mocks = vi.hoisted(() => ({ invoice: null as Record<string, unknown> | null, create: vi.fn() }))
vi.mock("../payments/public-access", () => ({ loadPublicInvoiceByToken: async () => ({ invoice: mocks.invoice, paymentState: "unpaid" }) }))
vi.mock("../payments/public", () => ({ getPublicInvoicePaymentSecret: () => "secret" }))
vi.mock("../db", () => ({
  prisma: {
    orgSettings: { findUnique: async () => ({}) },
    invoice: { updateMany: async () => ({ count: 1 }), findUniqueOrThrow: async () => mocks.invoice },
    payment: { findUnique: async () => null },
  },
}))
vi.mock("../payments/stripe", async importOriginal => ({
  ...(await importOriginal<typeof import("../payments/stripe")>()),
  getStripePaymentCredentials: () => ({ secretKey: "sk_test", publishableKey: "pk_test", webhookSecret: "wh" }),
  // The BYOK default reads credentials inside the module, so mocking the export above does not
  // reach it. Resolve the checkout target directly, as an org with its own Stripe keys would.
  resolveStripeCheckoutTarget: async () => ({ kind: "byok", secretKey: "sk_test", webhookSecret: "wh" }),
  expireOpenStripeCheckoutSession: vi.fn(),
  createStripeInvoiceCheckoutSession: mocks.create,
}))

import { resolvePublicInvoiceCheckout } from "../payments/public-checkout"
import { serializePublicInvoiceSession } from "../payments/public-session"
import { composeInvoiceEmail, type InvoiceForEmail } from "../../domain/documents/invoice-email"
import { reminderBlocker } from "../../domain/commands/reminders"
import { computeSettlement } from "../../domain/documents/settlement"
import { buildReminderEmailContent } from "../emails/reminder-email"

const decimal = (value: number) => new Prisma.Decimal(value)
const base = {
  id: "inv-1", organizationId: "org-1", number: "INV-0042", status: "sent", paymentStatus: "partial",
  locale: "en-US", timezone: "UTC", currency: "DKK", notes: null, paymentReference: null,
  issueDate: new Date("2026-10-01"), dueDate: new Date("2026-11-01"), supplyDate: null,
  subtotalNet: decimal(8000), totalTax: decimal(1999), totalGross: decimal(9999), pricesIncludeTax: false,
  amountPaid: decimal(500), amountCredited: decimal(250), stripeCheckoutSessionId: null,
  contact: { name: "Buyer", email: "buyer@example.invalid", company: null },
  sellerSnapshot: { companyName: "Seller", bankAccount: { regNumber: "1234", accountNumber: "5678901" } },
  buyerSnapshot: null, items: [], organization: { settings: null },
}
const frozen = {
  ...fixture.cases[0]!.payload,
  totals: { ...fixture.cases[0]!.payload.totals, gross: "2500.00" },
  seller: { companyName: "Seller", bankAccount: { regNumber: "1234", accountNumber: "5678901" } },
}
const settings = {
  companyName: "Seller", companyEmail: null, locale: "en-US", timezone: "UTC",
  stripePublishableKey: null, stripeSecretKeyEnc: null, stripeWebhookSecretEnc: null,
  documentSendingDomain: null, documentSendingDomainStatus: null, bankRegNumber: null, bankAccountNumber: null, paymentNote: null,
}

const reminderBalanceDue = (invoice: typeof base) => computeSettlement(invoice).balanceDue

describe("email, public page, Stripe checkout, reminders and payments all use the invoice row balance", () => {
  beforeEach(() => {
    mocks.create.mockReset()
    mocks.create.mockResolvedValue({ id: "cs_1", url: "https://checkout.example.invalid/cs_1" })
  })

  it.each([
    ["row gross when an issuance snapshot exists", frozen, 9249, 9999],
    ["row gross for invoices issued before snapshots", null, 9249, 9999],
  ])("uses the %s", async (_name, issuanceSnapshot, balance, gross) => {
    const invoice = { ...base, issuanceSnapshot }
    mocks.invoice = invoice

    const html = composeInvoiceEmail({ invoice: invoice as unknown as InvoiceForEmail, settings, to: "buyer@example.invalid", publicPaymentUrl: "https://app.example.invalid/pay/t" }).message.html
    const table = html.match(/<table aria-label="How to pay"[\s\S]*?<\/table>/)?.[0]
    const emailAmount = new Intl.NumberFormat("en-US", { style: "currency", currency: "DKK" }).format(balance).replace(" ", "\u00a0")
    expect(table).toContain(emailAmount)

    const page = serializePublicInvoiceSession({ invoice, paymentState: "unpaid", stripeEnabled: true }, "t")
    expect(page.invoice.balanceDue).toBe(balance)
    expect(page.invoice.totalGross).toBe(gross)

    expect(await resolvePublicInvoiceCheckout("t")).toEqual({ status: "redirect", url: "https://checkout.example.invalid/cs_1" })
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ amountDue: balance }))

    // The payment reminder states, and is eligible on, that same balance.
    expect(reminderBalanceDue(invoice).toNumber()).toBe(balance)
    expect(reminderBlocker(invoice)).toBeNull()
    const reminder = buildReminderEmailContent({
      fromName: "Seller", fromEmail: "noreply@example.invalid", replyTo: null, stage: "overdue",
      invoice: { number: "INV-0042", dueDate: invoice.dueDate, currency: "DKK", balanceDue: reminderBalanceDue(invoice).toNumber() },
      org: { companyName: "Seller", locale: "en-US" } as never, contactName: "Buyer", publicPaymentUrl: "https://app.example.invalid/pay/t",
    })
    expect(reminder.html).toContain(emailAmount)
  })

  it("settles reminders on the row balance", () => {
    const invoice = { ...base, issuanceSnapshot: frozen, amountPaid: decimal(9749), amountCredited: decimal(250) }
    expect(reminderBalanceDue(invoice).toNumber()).toBe(0)
    expect(reminderBlocker(invoice)).toBe("settled")
  })
})
