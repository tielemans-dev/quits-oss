import { beforeEach, describe, expect, it, vi } from "vitest"
import { processStripeWebhookRequest } from "../payments/webhooks"

const mocks = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), settings: vi.fn(), verifier: vi.fn(), construct: vi.fn(), invoice: vi.fn() }))
vi.mock("../observability", () => ({ appLogger: { child: () => mocks } }))
vi.mock("../db", () => ({ prisma: { orgSettings: { findMany: mocks.settings }, invoice: { findUnique: mocks.invoice } } }))
vi.mock("../payments/stripe", () => ({ constructStripeWebhookEvent: mocks.construct }))
vi.mock("../runtime/extensions", () => ({ getRuntimeExtensions: () => [{ resolveStripeConnectWebhook: mocks.verifier }] }))
vi.mock("../../domain/execute", () => ({ executeCommand: vi.fn() }))
vi.mock("../../domain/commands/payments", () => ({ recordStripeCheckoutFailure: {}, recordStripeCheckoutPayment: {} }))

describe("webhook processing alerts", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.verifier.mockResolvedValue(null)
    mocks.settings.mockResolvedValue([])
  })

  it.each(["verifier", "settings"] as const)("reports a thrown %s error once, without request or error contents", async source => {
    const failure = new Error("private connection details")
    mocks[source].mockRejectedValue(failure)
    await expect(processStripeWebhookRequest("private body", "private signature")).rejects.toBe(failure)
    expect(mocks.error).toHaveBeenCalledExactlyOnceWith("stripe.webhook.processing_failed", { errorType: "Error" })
  })

  it("keeps invalid signatures at warning level", async () => {
    await expect(processStripeWebhookRequest("{}", "bad")).rejects.toThrow("Invalid Stripe webhook signature")
    expect(mocks.warn).toHaveBeenCalledWith("stripe.webhook.invalid_signature", { candidateCount: 0 })
    expect(mocks.error).not.toHaveBeenCalled()
  })

  it("reports processing failure after verification and rethrows for the route", async () => {
    mocks.verifier.mockResolvedValue({ webhookSecret: "synthetic", resolveOrganizationId: async () => "org-1" })
    mocks.construct.mockReturnValue({ type: "checkout.session.completed", account: "acct-1", data: { object: {
      id: "cs-1", metadata: { invoiceId: "invoice-1" },
    } } })
    const failure = new Error("private database details")
    mocks.invoice.mockRejectedValue(failure)
    await expect(processStripeWebhookRequest("private body", "private signature")).rejects.toBe(failure)
    expect(mocks.error).toHaveBeenCalledExactlyOnceWith("stripe.webhook.processing_failed", {
      organizationId: "org-1", eventType: "checkout.session.completed", errorType: "Error",
    })
  })
})
