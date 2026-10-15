import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ resend: vi.fn(), sendMail: vi.fn(), close: vi.fn(), createTransport: vi.fn() }))
vi.mock("resend", () => ({ Resend: class { emails = { send: mocks.resend } } }))
vi.mock("nodemailer", () => ({ default: { createTransport: mocks.createTransport } }))

import { deliver } from "../../email"
import { deliverSmtp } from "../../email-smtp-node"

const message = { from: "seller@example.test", to: "buyer@example.test", subject: "Invoice", html: "<p>Invoice</p>", headers: { "List-Unsubscribe": "<https://app.example.test/api/reminders/unsubscribe?token=opaque>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } }

beforeEach(() => {
  vi.stubEnv("RESEND_API_KEY", "re_test")
  mocks.resend.mockResolvedValue({ data: { id: "resend-id" }, error: null })
  mocks.sendMail.mockResolvedValue({ accepted: [message.to], rejected: [], messageId: "smtp-id" })
  mocks.createTransport.mockReturnValue({ sendMail: mocks.sendMail, close: mocks.close })
})
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks() })

describe("reminder unsubscribe header transport", () => {
  it("passes both headers to Resend", async () => {
    await deliver(message, { provider: "resend", idempotencyKey: "invoice-one" })
    expect(mocks.resend).toHaveBeenCalledWith(message, { idempotencyKey: "invoice-one" })
  })

  it("passes both headers to SMTP", async () => {
    await deliverSmtp(message, { SMTP_HOST: "localhost", SMTP_PORT: "1025", SMTP_REQUIRE_TLS: "false" })
    expect(mocks.sendMail).toHaveBeenCalledWith(expect.objectContaining({ headers: message.headers }))
    expect(mocks.close).toHaveBeenCalledOnce()
  })
})
