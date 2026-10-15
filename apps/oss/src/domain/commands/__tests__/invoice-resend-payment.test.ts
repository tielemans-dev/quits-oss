// MOCK: synthetic issued invoice and Settings; the resend command and bank validation are real.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { Effect } from "effect"
import { Prisma } from "../../../../generated/prisma/client"
import { Command, Db, type CommandScope } from "../../services"
import { resendInvoiceEmail } from "../invoices"
import { composeInvoiceEmail } from "../../documents/invoice-email"
import { queueDocumentEmail } from "../../documents/document-delivery"
import { getRuntimeExtensions } from "../../../lib/runtime/extensions"

vi.mock("../../../lib/runtime/extensions", () => ({ getRuntimeExtensions: vi.fn(() => []) }))
const requirePaymentDetails = () => vi.mocked(getRuntimeExtensions).mockReturnValue([
  { resolveInvoiceIssuancePolicy: async () => ({ requirePaymentDetails: true }) },
] as never)

vi.mock("../../../lib/payments/public", async importOriginal => ({
  ...await importOriginal<typeof import("../../../lib/payments/public")>(),
  getPublicInvoicePaymentUrl: (invoice: { publicPaymentIssuedAt: Date | null }) => invoice.publicPaymentIssuedAt ? "https://pay.example.test/synthetic" : null,
}))
const cardCheckoutTarget = vi.hoisted(() => vi.fn(async (): Promise<object | null> => null))
vi.mock("../../../lib/payments/public-access", () => ({ resolveCardCheckoutTarget: cardCheckoutTarget }))
vi.mock("../../documents/document-delivery", () => ({
  refuseWhileSending: () => Effect.void,
  queueDocumentEmail: vi.fn(() => Effect.succeed({ document: {}, deliveryKey: "synthetic-delivery" })),
}))
vi.mock("../../documents/invoice-email", async importOriginal => ({
  ...await importOriginal<typeof import("../../documents/invoice-email")>(),
  resolveInvoiceEmailContext: (settings: { stripePublishableKey: string | null }) => ({
    stripeConfigured: Boolean(settings.stripePublishableKey), emailDelivery: { available: true },
  }),
  composeInvoiceEmail: vi.fn(() => ({ message: {}, usingBrandedDomain: false })),
}))

function harness({ bank = false, stripe = false, frozenBank = false, paymentLink = false } = {}) {
  const invoice = {
    id: "synthetic-invoice", status: "sent", number: "LEGACY-1", agreementId: null,
    publicPaymentIssuedAt: paymentLink ? new Date("2026-10-01") : null,
    sellerSnapshot: { companyName: "Original seller", ...(frozenBank ? { bankAccount: { regNumber: "0040", accountNumber: "0440116243" } } : {}) },
    contact: { email: "buyer@example.test" },
    paymentStatus: "unpaid", currency: "DKK",
    totalGross: new Prisma.Decimal(100), amountPaid: new Prisma.Decimal(0), amountCredited: new Prisma.Decimal(0),
  }
  const settings = {
    countryCode: "DK", stripePublishableKey: stripe ? "pk_test_synthetic" : null,
    bankRegNumber: bank ? "0040" : null, bankAccountNumber: bank ? "0440116243" : null,
  }
  const update = vi.fn()
  const db = {
    $queryRaw: vi.fn(async () => []), invoice: { findFirst: vi.fn(async () => invoice), update },
    orgSettings: { upsert: vi.fn(async () => settings) }, organizationTaxId: { findMany: vi.fn(async () => []) },
  }
  const command: CommandScope = {
    organizationId: "synthetic-org", commandId: "synthetic-command",
    actor: { kind: "user", organizationId: "synthetic-org", userId: "synthetic-user", roles: ["admin"], label: "User" },
    now: new Date("2026-10-14"), approvedByUserId: null, emit: vi.fn(), enqueue: vi.fn(),
  }
  const run = () => Effect.runPromise(Effect.either(resendInvoiceEmail.handle({ id: invoice.id }).pipe(
    Effect.provideService(Db, db as unknown as Prisma.TransactionClient), Effect.provideService(Command, command),
  )))
  return { invoice, update, run }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getRuntimeExtensions).mockReturnValue([])
  cardCheckoutTarget.mockResolvedValue(null)
})

describe("resend payment readiness", () => {
  it("resends without bank details or Stripe when no adopter policy requires them", async () => {
    const h = harness()
    expect(await h.run()).toMatchObject({ _tag: "Right" })
    expect(queueDocumentEmail).toHaveBeenCalledTimes(1)
  })
  it("refuses missing bank and Stripe before composing or queuing email when an adopter policy requires payment details", async () => {
    requirePaymentDetails()
    const h = harness()
    expect(await h.run()).toMatchObject({ _tag: "Left", left: { code: "invoice_issuance_policy", fieldIssues: [
      { code: "seller.bank.required", field: "seller.bankAccount", params: {} },
    ] } })
    expect(composeInvoiceEmail).not.toHaveBeenCalled()
    expect(queueDocumentEmail).not.toHaveBeenCalled()
    expect(h.update).not.toHaveBeenCalled()
  })
  it("resends on the bank account frozen on the invoice after Settings were cleared, even when an adopter requires payment details", async () => {
    requirePaymentDetails()
    const h = harness({ frozenBank: true })
    expect(await h.run()).toMatchObject({ _tag: "Right" })
    expect(queueDocumentEmail).toHaveBeenCalledTimes(1)
    expect(h.update).not.toHaveBeenCalled()
  })
  it.each([
    ["only today's Settings hold a bank account", { bank: true }],
    ["Stripe is configured but no payment link was issued with the invoice", { stripe: true }],
    ["both of those", { bank: true, stripe: true }],
  ])("refuses an adopter-required resend when %s, since the email would carry no payment details", async (_name, options) => {
    requirePaymentDetails()
    const h = harness(options)
    expect(await h.run()).toMatchObject({ _tag: "Left", left: { code: "invoice_issuance_policy", fieldIssues: [{ code: "seller.bank.required" }] } })
    expect(queueDocumentEmail).not.toHaveBeenCalled()
  })
  it("resends an adopter-required invoice whose issued payment link offers card payment", async () => {
    requirePaymentDetails()
    cardCheckoutTarget.mockResolvedValue({ kind: "byok" })
    const h = harness({ stripe: true, paymentLink: true })
    expect(await h.run()).toMatchObject({ _tag: "Right" })
    expect(composeInvoiceEmail).toHaveBeenCalledWith(expect.objectContaining({ publicPaymentUrl: "https://pay.example.test/synthetic" }))
  })
  it("refuses an adopter-required resend whose payment link opens a page with no payment method", async () => {
    requirePaymentDetails()
    cardCheckoutTarget.mockResolvedValue(null)
    const h = harness({ stripe: true, paymentLink: true })
    expect(await h.run()).toMatchObject({ _tag: "Left", left: { code: "invoice_issuance_policy", fieldIssues: [{ code: "seller.bank.required" }] } })
    expect(queueDocumentEmail).not.toHaveBeenCalled()
  })
  it.each([{ bank: true }, { stripe: true }])("allows current payment Settings %j without rewriting issued evidence", async options => {
    const h = harness(options)
    expect(await h.run()).toMatchObject({ _tag: "Right" })
    expect(composeInvoiceEmail).toHaveBeenCalledWith(expect.objectContaining({
      invoice: expect.objectContaining({ sellerSnapshot: h.invoice.sellerSnapshot }), publicPaymentUrl: null,
    }))
    expect(queueDocumentEmail).toHaveBeenCalledTimes(1)
    expect(h.invoice.sellerSnapshot).toEqual({ companyName: "Original seller" })
    expect(h.update).not.toHaveBeenCalled()
  })
})
