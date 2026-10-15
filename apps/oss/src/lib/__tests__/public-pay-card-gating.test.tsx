import type { StripeAccountStatus } from "@quits/contracts/payments"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { PublicInvoicePaymentPage } from "../../components/invoices/public-invoice-payment-page"
import { LocalizedDocument } from "../../components/documents/localized-document"
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

const state = vi.hoisted(() => ({
  createCheckout: vi.fn(),
  resolveTarget: vi.fn(),
  updateInvoice: vi.fn(async () => ({ count: 1 })),
  invoice: { status: "sent", paymentStatus: "unpaid", amountPaid: 0, amountCredited: 0, totalGross: 1250, currency: "DKK", locale: "en-US" },
  settings: {} as Settings,
}))

vi.mock("../db", () => ({
  prisma: {
    invoice: {
      findFirst: async (query: {
        where: { id: string; publicPaymentKeyVersion: number; status: { in: string[] } }
        include?: {
          organization?: { select?: { settings?: { select?: Record<string, boolean> } } }
        }
      }) => {
        if (query.where.id !== invoiceId || query.where.publicPaymentKeyVersion !== 1 ||
            !query.where.status.in.includes(state.invoice.status)) return null
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
          stripeCheckoutSessionId: null,
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
    orgSettings: { findUnique: async () => state.settings },
  },
}))
vi.mock("../payments/stripe", async importOriginal => ({
  ...(await importOriginal<typeof import("../payments/stripe")>()),
  createStripeInvoiceCheckoutSession: state.createCheckout,
}))
vi.mock("../secrets", () => ({ decryptSecret: () => "sk_test_synthetic" }))

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
    state.invoice = { status: "sent", paymentStatus: "unpaid", amountPaid: 0, amountCredited: 0, totalGross: 1250, currency: "DKK", locale: "en-US" }
    state.createCheckout.mockReset().mockResolvedValue({ id: "cs_test", url: "https://checkout.example/cs_test" })
    state.updateInvoice.mockClear()
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
})
