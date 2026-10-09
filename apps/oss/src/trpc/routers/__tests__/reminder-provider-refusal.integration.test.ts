import { randomUUID } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"
import { fetchRequestHandler } from "@trpc/server/adapters/fetch"
import superjson, { type SuperJSONResult } from "superjson"
import { deliver, EmailSendError } from "../../../lib/email"
import { prisma } from "../../../lib/db"
import { createTestOrganization, hasTestDatabase } from "../../../test-utils/organization"
import { appRouter } from "../../router"

vi.mock("../../../lib/email", async () => {
  const actual = await vi.importActual<typeof import("../../../lib/email")>("../../../lib/email")
  return { ...actual, deliver: vi.fn() }
})

describe.skipIf(!hasTestDatabase)("reminder provider refusals", () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => {
    vi.unstubAllEnvs()
    vi.mocked(deliver).mockReset()
    while (cleanups.length) await cleanups.pop()!()
  })

  it.each([
    ["validation_error", "email_provider_refused"],
    ["smtp_unavailable", "email_provider_unreachable"],
    ["rate_limit_exceeded", null],
  ] as const)("handles %s without exposing provider text", async (providerCode, reason) => {
    vi.stubEnv("EMAIL_PROVIDER", providerCode === "smtp_unavailable" ? "smtp" : "resend")
    vi.stubEnv("SMTP_HOST", "localhost")
    vi.stubEnv("RESEND_API_KEY", "test-key")
    vi.stubEnv("FROM_EMAIL", "sender@example.com")
    const org = await createTestOrganization({ roles: ["admin"] })
    cleanups.push(org.cleanup)
    const contact = await prisma.contact.create({ data: { organizationId: org.organizationId, name: "Buyer", email: "buyer@example.com" } })
    const invoice = await prisma.invoice.create({ data: {
      organizationId: org.organizationId, contactId: contact.id, number: randomUUID(), status: "sent",
      dueDate: new Date("2026-01-01"), totalGross: "100", subtotalNet: "100",
    } })
    const secret = "provider-error-with-secret-API-key"
    vi.mocked(deliver).mockRejectedValueOnce(new EmailSendError(providerCode, secret))
    const session = { user: { id: org.actors.admin.userId }, session: { activeOrganizationId: org.organizationId } }
    const response = await fetchRequestHandler({
      endpoint: "/api/trpc", router: appRouter,
      req: new Request("http://localhost/api/trpc/reminders.sendNow", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(superjson.serialize({ invoiceId: invoice.id })),
      }),
      createContext: async () => ({ session }) as never,
    })
    const text = await response.text()
    expect(text).not.toContain(secret)
    if (reason === null) {
      expect(response.status).toBe(200)
      const body = JSON.parse(text) as { result: { data: SuperJSONResult } }
      expect(superjson.deserialize(body.result.data)).toMatchObject({ delivery: "pending" })
      return
    }
    const body = JSON.parse(text) as { error: SuperJSONResult }
    const error = superjson.deserialize<{ message: string; data: { code: string; reason: string } }>(body.error)
    expect(error.data).toMatchObject({ code: "PRECONDITION_FAILED", reason })
    expect(error.message).toBe(reason === "email_provider_unreachable"
      ? "The email provider could not be reached. Check the email configuration."
      : "The email provider refused the email. Check the email configuration.")
    const history = await appRouter.createCaller({ session } as never).reminders.listForInvoice({ invoiceId: invoice.id })
    expect(JSON.stringify(history)).not.toContain(secret)
    expect(history.reminders[0]?.message).toBe(error.message)
    expect(deliver).toHaveBeenCalledTimes(1)
    // Older failed history can contain raw provider text; the read projection must sanitize it.
    await prisma.invoiceReminder.updateMany({ where: { invoiceId: invoice.id }, data: { outcomeMessage: secret } })
    const legacyHistory = await appRouter.createCaller({ session } as never).reminders.listForInvoice({ invoiceId: invoice.id })
    expect(JSON.stringify(legacyHistory)).not.toContain(secret)
    expect(legacyHistory.reminders[0]?.message).toBe("The email provider refused the email. Check the email configuration.")
  })
})
