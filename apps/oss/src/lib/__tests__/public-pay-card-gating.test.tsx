import type { StripeAccountStatus } from "@quits/contracts/payments"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { PublicInvoicePaymentPage } from "../../components/invoices/public-invoice-payment-page"
import { LocalizedDocument } from "../../components/documents/localized-document"
import { publicInvoiceLogo } from "../documents/public-logo-access"
import { publicInvoicePdf } from "../documents/pdf-access"
import { signInvoicePaymentToken } from "../payments/public"
import { loadPublicInvoiceByToken } from "../payments/public-access"
import { serializePublicInvoiceSession } from "../payments/public-session"
import { resolvePublicInvoiceCheckout } from "../payments/public-checkout"
import { setRuntimeExtensions } from "../runtime/extensions"

const secret = "pay-gating-test-secret"
const invoiceId = "inv-pay-gate"
type Settings = {
  locale: string
  timezone: string
  companyName: string
  companyLogo: string | null
  stripePublishableKey: string | null
  stripeSecretKeyEnc: string | null
  stripeWebhookSecretEnc: string | null
  stripeAccountStatus: StripeAccountStatus
}

const logo = "data:image/png;base64,AAAA"
type ExpireInput = { secretKey?: string; target?: { kind: string }; sessionId: string }

const state = vi.hoisted(() => ({
  createCheckout: vi.fn(),
  resolveTarget: vi.fn(),
  decryptSecret: vi.fn(() => "sk_test_synthetic"),
  expireCheckout: vi.fn(async (_input: ExpireInput) => "expired" as "expired" | "missing" | "not_open"),
  updateInvoice: vi.fn(async () => ({ count: 1 })),
  invoice: {
    status: "sent",
    paymentStatus: "unpaid",
    amountPaid: 0,
    amountCredited: 0,
    totalGross: 1250,
    currency: "DKK",
    locale: "en-US",
    stripeCheckoutSessionId: null as string | null,
  },
  settings: {} as Settings,
}))

vi.mock("../db", () => ({
  prisma: {
    invoice: {
      findFirst: async (query: {
        where: { id: string; organizationId?: string; publicPaymentKeyVersion?: number; status?: { in: string[] } }
        include?: {
          organization?: { select?: { settings?: { select?: Record<string, boolean> } } }
        }
      }) => {
        if (query.where.id !== invoiceId) return null
        // The public loader checks the payment link. The PDF route then loads the same invoice by id.
        if (query.where.publicPaymentKeyVersion !== undefined || query.where.status) {
          if (query.where.publicPaymentKeyVersion !== 1 || !query.where.status?.in.includes(state.invoice.status)) return null
        } else if (query.where.organizationId !== "org-pay-gate") return null
        const select = query.include?.organization?.select?.settings?.select
        const settings = select
          ? Object.fromEntries(
              (Object.keys(state.settings) as (keyof Settings)[])
                .filter((key) => select[key])
                .map((key) => [key, state.settings[key]]),
            )
          : state.settings
        return {
          id: invoiceId,
          organizationId: "org-pay-gate",
          number: "INV-0001",
          publicPaymentKeyVersion: 1,
          publicPaymentIssuedAt: new Date("2026-03-01T00:00:00.000Z"),
          issueDate: new Date("2026-03-01T00:00:00.000Z"),
          dueDate: new Date("2026-03-15T00:00:00.000Z"),
          totalTax: 250,
          subtotalNet: 1000,
          timezone: "UTC",
          notes: null,
          paymentReference: "REF-42",
          sellerSnapshot: {
            companyName: "Acme Studio",
            bankAccount: { regNumber: "0040", accountNumber: "0440116243", iban: "DK5000400440116243" },
          },
          buyerSnapshot: { name: "Buyer Name", company: "Buyer Co" },
          contact: { name: "Buyer Name", email: "buyer@example.com", company: "Buyer Co" },
          items: [{
            id: "item-1",
            description: "Consulting",
            quantity: 2,
            unitPriceGross: 625,
            lineGross: 1250,
            sortOrder: 0,
          }],
          ...state.invoice,
          organization: { settings },
        }
      },
      updateMany: state.updateInvoice,
      findUniqueOrThrow: async () => state.invoice,
    },
    payment: { findUnique: async () => null },
    orgSettings: { findUnique: async () => state.settings },
  },
}))
vi.mock("../payments/stripe", async importOriginal => ({
  ...(await importOriginal<typeof import("../payments/stripe")>()),
  createStripeInvoiceCheckoutSession: state.createCheckout,
  expireOpenStripeCheckoutSession: state.expireCheckout,
}))
vi.mock("../secrets", () => ({ decryptSecret: state.decryptSecret }))

const token = signInvoicePaymentToken({ invoiceId, keyVersion: 1, scope: "invoice_payment" }, secret)
async function publicSession() {
  const loaded = await loadPublicInvoiceByToken(token, secret)
  return loaded ? serializePublicInvoiceSession(loaded, token) : null
}

/** Loads /pay the way the route does, then renders that state. */
async function publicPayPage() {
  const session = await publicSession()
  if (!session) return "invalid"
  return renderToStaticMarkup(<LocalizedDocument locale={session.locale}>
    <PublicInvoicePaymentPage token={token} state={{ kind: "ready", ...session }} />
  </LocalizedDocument>)
}

const configuredByok = {
  stripePublishableKey: "pk_test_123456789",
  stripeSecretKeyEnc: "encrypted-secret",
  stripeWebhookSecretEnc: "encrypted-webhook",
}

describe("public pay card gating", () => {
  beforeEach(() => {
    vi.stubEnv("QUITS_PUBLIC_PAYMENT_SECRET", secret)
    state.settings = {
      locale: "en-US", timezone: "UTC", companyName: "Acme Studio", companyLogo: null,
      stripePublishableKey: null, stripeSecretKeyEnc: null, stripeWebhookSecretEnc: null,
      stripeAccountStatus: "none",
    }
    state.invoice = { status: "sent", paymentStatus: "unpaid", amountPaid: 0, amountCredited: 0, totalGross: 1250, currency: "DKK", locale: "en-US", stripeCheckoutSessionId: null }
    state.createCheckout.mockReset().mockResolvedValue({ id: "cs_test", url: "https://checkout.example/cs_test" })
    state.decryptSecret.mockReset().mockReturnValue("sk_test_synthetic")
    state.expireCheckout.mockReset().mockResolvedValue("expired")
    state.updateInvoice.mockReset().mockResolvedValue({ count: 1 })
    state.resolveTarget.mockReset().mockReturnValue({
      kind: "connect", stripeAccount: "acct_test",
      client: { checkout: { sessions: { create: vi.fn(), expire: vi.fn(), retrieve: vi.fn() } } },
    })
    setRuntimeExtensions([{ id: "test-connect", resolveStripeCheckoutTarget: state.resolveTarget }])
  })

  afterEach(() => { setRuntimeExtensions([]); vi.unstubAllEnvs() })

  async function expectUnavailable() {
    const html = await publicPayPage()
    expect(html).toContain("0440116243")
    expect(html).not.toContain("Pay now")
    expect(await resolvePublicInvoiceCheckout(token)).toEqual({ status: "unavailable", url: null })
    expect(state.createCheckout).not.toHaveBeenCalled()
    expect(state.updateInvoice).not.toHaveBeenCalled()
  }

  it.each(["none", "pending", "restricted"] as const)("blocks %s even when an extension returns Connect", async status => {
    state.settings.stripeAccountStatus = status
    await expectUnavailable()
    expect(state.resolveTarget).not.toHaveBeenCalled()
  })

  it.each(["none", "pending", "restricted"] as const)("falls back to BYOK instead of charging a %s Connect target", async status => {
    Object.assign(state.settings, configuredByok, { stripeAccountStatus: status })
    expect(await publicPayPage()).toContain("Pay now")
    expect(await resolvePublicInvoiceCheckout(token)).toMatchObject({ status: "redirect" })
    expect(state.createCheckout).toHaveBeenCalledWith(expect.objectContaining({ target: expect.objectContaining({ kind: "byok" }) }))
  })

  it("shows card and transfer details and opens checkout for active Connect", async () => {
    state.settings.stripeAccountStatus = "active"
    const html = await publicPayPage()
    for (const value of ["Pay now", "Payment details", "0440116243", "REF-42"]) expect(html).toContain(value)
    expect(await resolvePublicInvoiceCheckout(token)).toEqual({ status: "redirect", url: "https://checkout.example/cs_test" })
    expect(state.createCheckout).toHaveBeenCalledWith(expect.objectContaining({ target: expect.objectContaining({ kind: "connect" }), amountDue: 1250 }))
  })

  it("hides card and rejects checkout for active Connect without an extension", async () => {
    state.settings.stripeAccountStatus = "active"
    setRuntimeExtensions([])
    await expectUnavailable()
  })

  it.each(["none", "pending", "restricted", "active"] as const)("keeps self-hosted BYOK usable with %s Connect status", async status => {
    Object.assign(state.settings, configuredByok, { stripeAccountStatus: status })
    setRuntimeExtensions([])
    expect(await publicPayPage()).toContain("Pay now")
    expect(await resolvePublicInvoiceCheckout(token)).toMatchObject({ status: "redirect" })
    expect(state.createCheckout).toHaveBeenCalledWith(expect.objectContaining({ target: expect.objectContaining({ kind: "byok" }) }))
  })

  it.each(Object.keys(configuredByok) as (keyof typeof configuredByok)[])("blocks BYOK missing %s", async missing => {
    Object.assign(state.settings, configuredByok, { [missing]: null })
    setRuntimeExtensions([])
    await expectUnavailable()
  })

  it.each(["paid", "credited"])("keeps %s links readable and refuses another checkout", async status => {
    Object.assign(state.settings, configuredByok)
    setRuntimeExtensions([])
    Object.assign(state.invoice, { status, ...(status === "paid" ? { paymentStatus: "paid", amountPaid: 1250 } : { amountCredited: 1250 }) })
    expect(await publicSession()).toMatchObject({ paymentState: "paid", stripeEnabled: false })
    expect(await publicPayPage()).not.toContain("Pay now")
    expect(await resolvePublicInvoiceCheckout(token)).toEqual({ status: "paid", url: null })
    expect(state.createCheckout).not.toHaveBeenCalled()
  })

  it.each(["void", "draft"])("rejects a %s invoice at the loader and checkout boundary", async status => {
    state.settings.stripeAccountStatus = "active"
    state.invoice.status = status
    expect(await publicSession()).toBeNull()
    expect(await resolvePublicInvoiceCheckout(token)).toEqual({ status: "invalid", url: null })
    expect(state.createCheckout).not.toHaveBeenCalled()
  })

  it("charges only the remaining balance of a partially paid and credited invoice", async () => {
    state.settings.stripeAccountStatus = "active"
    Object.assign(state.invoice, { paymentStatus: "partially_paid", amountPaid: 500, amountCredited: 250 })
    expect(await publicSession()).toMatchObject({ stripeEnabled: true, invoice: { balanceDue: 500 } })
    expect(await publicPayPage()).toContain("Pay now")
    expect(await resolvePublicInvoiceCheckout(token)).toMatchObject({ status: "redirect" })
    expect(state.createCheckout).toHaveBeenCalledWith(expect.objectContaining({ amountDue: 500 }))
  })

  it.each([[100.49, false], [100, true]] as const)("gates %s JPY consistently with checkout", async (totalGross, enabled) => {
    state.settings.stripeAccountStatus = "active"
    Object.assign(state.invoice, { currency: "JPY", totalGross })
    expect((await publicPayPage()).includes("Pay now")).toBe(enabled)
    expect(await resolvePublicInvoiceCheckout(token)).toMatchObject({ status: enabled ? "redirect" : "unavailable" })
    expect(state.createCheckout).toHaveBeenCalledTimes(enabled ? 1 : 0)
  })

  it("hides the card action for a zero balance even if payment status has not caught up", async () => {
    state.settings.stripeAccountStatus = "active"
    state.invoice.amountPaid = 1250
    const session = await publicSession()
    expect(session).toMatchObject({ stripeEnabled: false })
    expect(await publicPayPage()).not.toContain("Pay now")
    // A stale client flag must not offer a zero-balance payment either.
    if (!session) throw new Error("Expected a readable settled invoice")
    expect(renderToStaticMarkup(<LocalizedDocument locale={session.locale}>
      <PublicInvoicePaymentPage token={token} state={{ kind: "ready", ...session, stripeEnabled: true }} />
    </LocalizedDocument>)).not.toContain("Pay now")
    expect(await resolvePublicInvoiceCheckout(token)).toEqual({ status: "paid", url: null })
    expect(state.createCheckout).not.toHaveBeenCalled()
  })

  it.each(["pending", "active"] as const)("renders the %s card gate and transfer details in Danish", async status => {
    state.settings.stripeAccountStatus = status
    state.invoice.locale = "da-DK"
    const html = await publicPayPage()
    expect(html).toContain('lang="da-DK"')
    expect(html).toContain("Betalingsbesked")
    expect(html).toContain("0440116243")
    expect(html.includes("Betal nu")).toBe(status === "active")
    expect(html).not.toContain("Pay now")
  })

  it("never serializes Stripe credentials or the resolved target into the public session", async () => {
    Object.assign(state.settings, configuredByok)
    setRuntimeExtensions([])
    const session = await publicSession()
    expect(session?.stripeEnabled).toBe(true)
    const serialized = JSON.stringify(session)
    for (const value of [...Object.keys(configuredByok), ...Object.values(configuredByok), "sk_test_synthetic", "webhookSecret", "secretKey", "checkoutTarget"]) {
      expect(serialized).not.toContain(value)
    }
  })

  async function expectInvoiceReadableWithoutCard() {
    const loaded = await loadPublicInvoiceByToken(token, secret)
    expect(loaded?.invoice).toMatchObject({ id: invoiceId, number: "INV-0001", organizationId: "org-pay-gate" })
    expect(loaded?.stripeEnabled).toBe(false)
    const html = await publicPayPage()
    expect(html).toContain("0440116243")
    expect(html).toContain(`/pay/${encodeURIComponent(token)}/logo`)
    expect(html).toContain("Acme Studio")
    expect(html).not.toContain("Pay now")
    expect((await publicInvoiceLogo(token)).status).toBe(200)
    const pdf = await publicInvoicePdf(token)
    expect(pdf.status).not.toBe(404)
    expect(await pdf.text()).not.toBe("This link is no longer valid")
    expect(await resolvePublicInvoiceCheckout(token)).toEqual({ status: "unavailable", url: null })
    expect(state.createCheckout).not.toHaveBeenCalled()
  }

  it("keeps the invoice readable when the checkout extension throws", async () => {
    state.settings.stripeAccountStatus = "active"
    state.settings.companyLogo = logo
    state.resolveTarget.mockRejectedValue(new Error("connect resolver failed"))
    await expectInvoiceReadableWithoutCard()
  })

  it("keeps the invoice readable when BYOK ciphertext cannot be decrypted", async () => {
    Object.assign(state.settings, configuredByok, { stripeAccountStatus: "pending", companyLogo: logo })
    state.decryptSecret.mockImplementation(() => { throw new Error("encryption secret changed") })
    await expectInvoiceReadableWithoutCard()
  })

  it("expires a tracked BYOK session with its own key before opening Connect", async () => {
    Object.assign(state.settings, configuredByok, { stripeAccountStatus: "active" })
    state.invoice.stripeCheckoutSessionId = "cs_byok_open"
    state.expireCheckout.mockImplementation(async (input: ExpireInput) => input.secretKey ? "expired" : "missing")
    expect(await resolvePublicInvoiceCheckout(token)).toEqual({ status: "redirect", url: "https://checkout.example/cs_test" })
    expect(state.expireCheckout).toHaveBeenNthCalledWith(1, { secretKey: "sk_test_synthetic", sessionId: "cs_byok_open" })
    expect(state.expireCheckout).toHaveBeenCalledTimes(1)
    expect(state.expireCheckout.mock.invocationCallOrder[0]).toBeLessThan(state.createCheckout.mock.invocationCallOrder[0])
    expect(state.createCheckout).toHaveBeenCalledWith(expect.objectContaining({ target: expect.objectContaining({ kind: "connect" }) }))
  })

  it("does not treat resource_missing on BYOK as expiry of a Connect session", async () => {
    Object.assign(state.settings, configuredByok, { stripeAccountStatus: "active" })
    state.invoice.stripeCheckoutSessionId = "cs_connect_open"
    state.expireCheckout.mockImplementation(async (input: ExpireInput) => input.secretKey ? "missing" : "expired")
    expect(await resolvePublicInvoiceCheckout(token)).toMatchObject({ status: "redirect" })
    expect(state.expireCheckout.mock.calls.map(call => call[0].secretKey ? "byok" : "connect")).toEqual(["byok", "connect"])
    expect(state.expireCheckout).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionId: "cs_connect_open",
      target: expect.objectContaining({ kind: "connect" }),
    }))
    expect(state.expireCheckout.mock.invocationCallOrder[1]).toBeLessThan(state.createCheckout.mock.invocationCallOrder[0])
  })

  it("refuses a new Connect session when the BYOK session cannot be expired", async () => {
    Object.assign(state.settings, configuredByok, { stripeAccountStatus: "active" })
    state.invoice.stripeCheckoutSessionId = "cs_byok_open"
    state.expireCheckout.mockImplementation(async (input: ExpireInput) => {
      if (input.secretKey) throw new Error("byok unavailable")
      return "missing"
    })
    expect(await resolvePublicInvoiceCheckout(token)).toEqual({ status: "unavailable", url: null })
    expect(state.createCheckout).not.toHaveBeenCalled()
    expect(state.expireCheckout).toHaveBeenCalledTimes(1)
    expect(state.expireCheckout).toHaveBeenCalledWith({ secretKey: "sk_test_synthetic", sessionId: "cs_byok_open" })
  })

  it("expires a session opened in this request on the Connect account that created it", async () => {
    Object.assign(state.settings, configuredByok, { stripeAccountStatus: "active" })
    state.updateInvoice.mockResolvedValue({ count: 0 })
    state.expireCheckout.mockImplementation(async (input: ExpireInput) => input.secretKey ? "expired" : "expired")
    expect(await resolvePublicInvoiceCheckout(token)).toEqual({ status: "unavailable", url: null })
    expect(state.createCheckout).toHaveBeenCalledTimes(3)
    expect(state.expireCheckout).toHaveBeenCalledTimes(3)
    for (const [input] of state.expireCheckout.mock.calls) {
      expect(input.secretKey).toBeUndefined()
      expect(input).toEqual(expect.objectContaining({ sessionId: "cs_test", target: expect.objectContaining({ kind: "connect" }) }))
    }
  })
})
