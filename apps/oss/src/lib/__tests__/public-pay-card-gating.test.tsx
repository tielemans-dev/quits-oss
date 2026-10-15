import type { ReactNode } from "react"
import type { StripeAccountStatus } from "@quits/contracts/payments"
import { describe, expect, it, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { PublicInvoicePaymentPage } from "../../components/invoices/public-invoice-payment-page"
import { LocalizedDocument } from "../../components/documents/localized-document"
import { signInvoicePaymentToken } from "../payments/public"
import { loadPublicInvoiceByToken } from "../payments/public-access"
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
}))

vi.mock("../db", () => ({
  prisma: {
    invoice: {
      findFirst: async (query: {
        where: { id: string; publicPaymentKeyVersion: number }
        include?: {
          organization?: { select?: { settings?: { select?: Record<string, boolean> } } }
        }
      }) => {
        if (query.where.id !== invoiceId || query.where.publicPaymentKeyVersion !== 1) return null
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
          number: "INV-0001",
          status: "sent",
          paymentStatus: "unpaid",
          publicPaymentKeyVersion: 1,
          publicPaymentIssuedAt: new Date("2026-03-01T00:00:00.000Z"),
          issueDate: new Date("2026-03-01T00:00:00.000Z"),
          dueDate: new Date("2026-03-15T00:00:00.000Z"),
          totalGross: 1250,
          amountPaid: 0,
          amountCredited: 0,
          totalTax: 250,
          subtotalNet: 1000,
          currency: "DKK",
          locale: "en-US",
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

/** Loads /pay the way the route does, then renders that state. */
async function publicPayPage(status: StripeAccountStatus, byok?: Partial<Settings>) {
  state.settings = {
    locale: "en-US",
    timezone: "UTC",
    companyName: "Acme Studio",
    companyLogo: null,
    stripePublishableKey: null,
    stripeSecretKeyEnc: null,
    stripeWebhookSecretEnc: null,
    stripeAccountStatus: status,
    ...byok,
  }
  const token = signInvoicePaymentToken(
    { invoiceId, keyVersion: 1, scope: "invoice_payment" },
    secret,
  )
  const loaded = await loadPublicInvoiceByToken(token, secret)
  if (!loaded) throw new Error("public invoice loader returned nothing")
  const session = serializePublicInvoiceSession(loaded, token)
  return page(session.locale, (
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
}

const configuredByok = {
  stripePublishableKey: "pk_test_123456789",
  stripeSecretKeyEnc: "encrypted-secret",
  stripeWebhookSecretEnc: "encrypted-webhook",
}

describe("public pay card gating", () => {
  it("shows bank transfer only when Stripe is not connected", async () => {
    const html = await publicPayPage("none")
    expect(html).toContain("Payment details")
    expect(html).toContain("0440116243")
    expect(html).toContain("Pay by bank transfer using the details and reference below.")
    expect(html).not.toContain("Pay now")
  })

  it("shows the card button and bank transfer when Connect can take card payments", async () => {
    const html = await publicPayPage("active")
    expect(html).toContain("Pay now")
    expect(html).toContain("Payment details")
    expect(html).toContain("0440116243")
    expect(html).toContain("REF-42")
  })

  it("shows bank transfer only when the Connect account is restricted", async () => {
    const html = await publicPayPage("restricted")
    expect(html).toContain("Payment details")
    expect(html).toContain("0440116243")
    expect(html).not.toContain("Pay now")
  })

  it("keeps bank transfer and hides the card button while Connect onboarding is pending", async () => {
    const html = await publicPayPage("pending")
    expect(html).toContain("0440116243")
    expect(html).not.toContain("Pay now")
  })

  it("shows the card button when own Stripe keys are configured, whatever the Connect status", async () => {
    for (const status of ["none", "pending", "restricted", "active"] as const) {
      const html = await publicPayPage(status, configuredByok)
      expect(html).toContain("Pay now")
      expect(html).toContain("0440116243")
    }
  })

  it("does not treat a partial key set as ready", async () => {
    const html = await publicPayPage("none", {
      stripePublishableKey: "pk_test_123456789",
      stripeSecretKeyEnc: "encrypted-secret",
      stripeWebhookSecretEnc: null,
    })
    expect(html).toContain("0440116243")
    expect(html).not.toContain("Pay now")
  })
})
