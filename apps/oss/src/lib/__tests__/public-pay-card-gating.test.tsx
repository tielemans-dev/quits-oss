import type { ReactNode } from "react"
import type { StripeAccountStatus } from "@quits/contracts/payments"
import { afterEach, describe, expect, it, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { PublicInvoicePaymentPage } from "../../components/invoices/public-invoice-payment-page"
import { LocalizedDocument } from "../../components/documents/localized-document"
import { setRuntimeExtensions } from "../runtime/extensions"
import { signInvoicePaymentToken } from "../payments/public"
import { loadPublicInvoiceByToken } from "../payments/public-access"
import { resolvePublicInvoiceCheckout } from "../payments/public-checkout"
import { serializePublicInvoiceSession } from "../payments/public-session"

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

type InvoiceState = {
  status: string
  paymentStatus: string
  currency: string
  locale: string
  totalGross: number
  amountPaid: number
  amountCredited: number
  totalTax: number
  subtotalNet: number
}

const defaultSettings = (): Settings => ({
  locale: "en-US",
  timezone: "UTC",
  companyName: "Acme Studio",
  companyLogo: null,
  stripePublishableKey: null,
  stripeSecretKeyEnc: null,
  stripeWebhookSecretEnc: null,
  stripeAccountStatus: "none",
})

const defaultInvoice = (): InvoiceState => ({
  status: "sent",
  paymentStatus: "unpaid",
  currency: "DKK",
  locale: "en-US",
  totalGross: 1250,
  amountPaid: 0,
  amountCredited: 0,
  totalTax: 250,
  subtotalNet: 1000,
})

const state = vi.hoisted(() => ({
  settings: {
    locale: "en-US",
    timezone: "UTC",
    companyName: "Acme Studio",
    companyLogo: null,
    stripePublishableKey: null,
    stripeSecretKeyEnc: null,
    stripeWebhookSecretEnc: null,
    stripeAccountStatus: "none",
  } as Settings,
  invoice: {
    status: "sent",
    paymentStatus: "unpaid",
    currency: "DKK",
    locale: "en-US",
    totalGross: 1250,
    amountPaid: 0,
    amountCredited: 0,
    totalTax: 250,
    subtotalNet: 1000,
  } as InvoiceState,
}))

vi.mock("../db", () => ({
  prisma: {
    invoice: {
      findFirst: async (query: {
        where: {
          id: string
          publicPaymentKeyVersion: number
          status?: { in?: string[] }
        }
        include?: {
          organization?: { select?: { settings?: { select?: Record<string, boolean> } } }
        }
      }) => {
        if (query.where.id !== invoiceId || query.where.publicPaymentKeyVersion !== 1) return null
        const allowed = query.where.status?.in
        if (allowed && !allowed.includes(state.invoice.status)) return null
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
          status: state.invoice.status,
          paymentStatus: state.invoice.paymentStatus,
          publicPaymentKeyVersion: 1,
          publicPaymentIssuedAt: new Date("2026-03-01T00:00:00.000Z"),
          issueDate: new Date("2026-03-01T00:00:00.000Z"),
          dueDate: new Date("2026-03-15T00:00:00.000Z"),
          totalGross: state.invoice.totalGross,
          amountPaid: state.invoice.amountPaid,
          amountCredited: state.invoice.amountCredited,
          totalTax: state.invoice.totalTax,
          subtotalNet: state.invoice.subtotalNet,
          currency: state.invoice.currency,
          locale: state.invoice.locale,
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
          organization: { settings },
        }
      },
    },
  },
}))

function page(locale: string, children: ReactNode) {
  return renderToStaticMarkup(<LocalizedDocument locale={locale}>{children}</LocalizedDocument>)
}

function usePayState(status: StripeAccountStatus, options?: { byok?: Partial<Settings>; invoice?: Partial<InvoiceState> }) {
  state.settings = { ...defaultSettings(), stripeAccountStatus: status, ...options?.byok }
  state.invoice = { ...defaultInvoice(), ...options?.invoice }
}

function paymentToken() {
  return signInvoicePaymentToken(
    { invoiceId, keyVersion: 1, scope: "invoice_payment" },
    secret,
  )
}

/** Loads /pay the way the route does, then renders that state. */
async function publicPayPage(status: StripeAccountStatus, options?: { byok?: Partial<Settings>; invoice?: Partial<InvoiceState> }) {
  usePayState(status, options)
  const token = paymentToken()
  const loaded = await loadPublicInvoiceByToken(token, secret)
  if (!loaded) throw new Error("public invoice loader returned nothing")
  const session = serializePublicInvoiceSession(loaded, token)
  const html = page(session.locale, (
    <PublicInvoicePaymentPage
      token={token}
      state={{
        kind: "ready",
        paymentState: session.paymentState,
        stripeEnabled: session.stripeEnabled,
        seller: session.seller,
        invoice: session.invoice,
      }}
    />
  ))
  return { html, session, loaded }
}

const configuredByok = {
  stripePublishableKey: "pk_test_123456789",
  stripeSecretKeyEnc: "encrypted-secret",
  stripeWebhookSecretEnc: "encrypted-webhook",
}

const previousSecret = process.env.QUITS_PUBLIC_PAYMENT_SECRET

afterEach(() => {
  process.env.QUITS_PUBLIC_PAYMENT_SECRET = previousSecret
  setRuntimeExtensions([])
})

describe("public pay card gating", () => {
  it("shows bank transfer only when Stripe is not connected", async () => {
    const { html } = await publicPayPage("none")
    expect(html).toContain("Payment details")
    expect(html).toContain("0440116243")
    expect(html).toContain("Pay by bank transfer using the details and reference below.")
    expect(html).not.toContain("Pay now")
  })

  it("shows the card button and bank transfer when Connect can take card payments", async () => {
    const { html } = await publicPayPage("active")
    expect(html).toContain("Pay now")
    expect(html).toContain("Payment details")
    expect(html).toContain("0440116243")
    expect(html).toContain("REF-42")
  })

  it("shows bank transfer only when the Connect account is restricted", async () => {
    const { html } = await publicPayPage("restricted")
    expect(html).toContain("Payment details")
    expect(html).toContain("0440116243")
    expect(html).not.toContain("Pay now")
  })

  it("keeps bank transfer and hides the card button while Connect onboarding is pending", async () => {
    const { html } = await publicPayPage("pending")
    expect(html).toContain("0440116243")
    expect(html).not.toContain("Pay now")
  })

  it("shows the card button when own Stripe keys are configured, whatever the Connect status", async () => {
    for (const status of ["none", "pending", "restricted", "active"] as const) {
      const { html } = await publicPayPage(status, { byok: configuredByok })
      expect(html).toContain("Pay now")
      expect(html).toContain("0440116243")
    }
  })

  it("does not treat a partial key set as ready", async () => {
    const { html } = await publicPayPage("none", {
      byok: {
        stripePublishableKey: "pk_test_123456789",
        stripeSecretKeyEnc: "encrypted-secret",
        stripeWebhookSecretEnc: null,
      },
    })
    expect(html).toContain("0440116243")
    expect(html).not.toContain("Pay now")
  })

  it("renders the card button in Danish when card checkout is ready", async () => {
    const { html } = await publicPayPage("active", { invoice: { locale: "da-DK" } })
    expect(html).toContain("Betal nu")
    expect(html).toContain("0440116243")
  })

  it("offers no card button once the invoice is paid or credited", async () => {
    const paid = await publicPayPage("active", { invoice: { status: "paid", paymentStatus: "paid" } })
    expect(paid.html).not.toContain("Pay now")
    expect(paid.html).not.toContain("Betal nu")

    const credited = await publicPayPage("active", {
      invoice: { status: "credited", paymentStatus: "unpaid", amountCredited: 1250 },
    })
    expect(credited.html).not.toContain("Pay now")
    expect(credited.html).not.toContain("Betal nu")
  })

  it("hides the card button when the balance cannot be charged in that currency", async () => {
    const { html } = await publicPayPage("active", {
      invoice: { currency: "JPY", totalGross: 100.49, totalTax: 0, subtotalNet: 100.49 },
    })
    expect(html).not.toContain("Pay now")
    expect(html).toContain("0440116243")
  })

  it("offers nothing to pay when the balance due is already zero", async () => {
    const { html } = await publicPayPage("active", { invoice: { amountPaid: 1250 } })
    expect(html).not.toContain("Pay now")
    expect(html).not.toContain("Payment details")
  })

  it("keeps encrypted Stripe keys on the loaded invoice and off the public session", async () => {
    const { loaded, session, html } = await publicPayPage("none", { byok: configuredByok })
    expect(loaded.invoice.organization?.settings?.stripeSecretKeyEnc).toBe("encrypted-secret")
    expect(loaded.invoice.organization?.settings?.stripeWebhookSecretEnc).toBe("encrypted-webhook")
    const published = JSON.stringify(session)
    expect(published).not.toContain("encrypted-secret")
    expect(published).not.toContain("encrypted-webhook")
    expect(published).not.toContain("pk_test_")
    expect(html).not.toContain("encrypted-secret")
    expect(html).not.toContain("pk_test_")
  })
})

describe("public checkout card gating", () => {
  async function checkout(status: StripeAccountStatus, options?: { byok?: Partial<Settings>; invoice?: Partial<InvoiceState> }) {
    process.env.QUITS_PUBLIC_PAYMENT_SECRET = secret
    usePayState(status, options)
    const create = vi.fn()
    const resolveStripeCheckoutTarget = vi.fn(async () => ({
      kind: "connect" as const,
      stripeAccount: "acct_test",
      client: { checkout: { sessions: { create, expire: vi.fn(), retrieve: vi.fn() } } },
    }))
    setRuntimeExtensions([{ id: "stripe-connect", resolveStripeCheckoutTarget }])
    const result = await resolvePublicInvoiceCheckout(paymentToken())
    return { result, create, resolveStripeCheckoutTarget }
  }

  it.each(["pending", "restricted", "none"] as const)(
    "returns unavailable for Connect status %s without calling Stripe",
    async (status) => {
      const { result, create, resolveStripeCheckoutTarget } = await checkout(status)
      expect(result).toEqual({ url: null, status: "unavailable" })
      expect(resolveStripeCheckoutTarget).not.toHaveBeenCalled()
      expect(create).not.toHaveBeenCalled()
    },
  )

  it("returns unavailable for a partial BYOK key set without calling Stripe", async () => {
    const { result, create, resolveStripeCheckoutTarget } = await checkout("none", {
      byok: {
        stripePublishableKey: "pk_test_123456789",
        stripeSecretKeyEnc: "encrypted-secret",
        stripeWebhookSecretEnc: null,
      },
    })
    expect(result).toEqual({ url: null, status: "unavailable" })
    expect(resolveStripeCheckoutTarget).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  })

  it("returns unavailable for a balance the currency cannot represent without calling Stripe", async () => {
    const { result, create, resolveStripeCheckoutTarget } = await checkout("active", {
      invoice: { currency: "JPY", totalGross: 100.49, totalTax: 0, subtotalNet: 100.49 },
    })
    expect(result).toEqual({ url: null, status: "unavailable" })
    expect(resolveStripeCheckoutTarget).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  })

  it("returns paid for a settled invoice without calling Stripe", async () => {
    const paid = await checkout("active", { invoice: { status: "paid", paymentStatus: "paid" } })
    expect(paid.result).toEqual({ url: null, status: "paid" })
    expect(paid.resolveStripeCheckoutTarget).not.toHaveBeenCalled()
    expect(paid.create).not.toHaveBeenCalled()

    const credited = await checkout("active", {
      invoice: { status: "credited", paymentStatus: "unpaid", amountCredited: 1250 },
    })
    expect(credited.result).toEqual({ url: null, status: "paid" })
    expect(credited.create).not.toHaveBeenCalled()
  })
})
