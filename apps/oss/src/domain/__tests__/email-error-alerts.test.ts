import { beforeEach, describe, expect, it, vi } from "vitest"
import { EMAIL_DELIVERY_JOB, registerDeliveryCompletion } from "../delivery/outbox"
import { registerJobHandler, TerminalJobError, type JobHandler } from "../jobs"
import { deliver, EmailSendError, ensureEmailProvider } from "../../lib/email"

const mocks = vi.hoisted(() => ({ error: vi.fn(), update: vi.fn(), failed: vi.fn(), withdrawal: vi.fn() }))
vi.mock("../../lib/observability", () => ({ appLogger: { child: () => mocks } }))
vi.mock("../../lib/db", () => ({ prisma: {
  job: { updateMany: mocks.update },
  $transaction: async (run: (tx: unknown) => Promise<void>) => run({ job: { updateMany: mocks.update } }),
} }))
vi.mock("../../lib/email", () => ({ deliver: vi.fn(), ensureEmailProvider: vi.fn(), EmailSendError: class extends Error { constructor(public providerCode: string, message: string) { super(message) } } }))
vi.mock("../jobs", () => ({ registerJobHandler: vi.fn(), TerminalJobError: class extends Error {}, StaleJobClaimError: class extends Error {} }))
vi.mock("../scheduler", () => ({ registerTickTask: vi.fn() }))
vi.mock("../events", () => ({ appendEvents: vi.fn() }))
vi.mock("../documents/artifacts", () => ({ lockArtifactOrganization: vi.fn() }))
vi.mock("../../lib/reminders/unsubscribe", () => ({ addReminderUnsubscribe: vi.fn() }))

const handler = vi.mocked(registerJobHandler).mock.calls.find(([type]) => type === EMAIL_DELIVERY_JOB)![1]
const job = (overrides = {}) => ({
  id: "job-1", organizationId: "org-1", claimToken: "claim-1", attempts: 1, createdAt: new Date(),
  payload: { message: { from: "sender@example.test", to: "private@example.test", subject: "private", html: "private" },
    idempotencyKey: "delivery-1", completion: { kind: "invoice", target: { invoiceId: "invoice-1" } },
    actor: { kind: "system" }, commandId: "command-1", approvedByUserId: null, provider: "smtp", requests: 0 }, ...overrides,
}) satisfies Parameters<JobHandler>[0]

describe("email delivery alerts", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.update.mockResolvedValue({ count: 1 })
    mocks.failed.mockResolvedValue([])
    mocks.withdrawal.mockResolvedValue(null)
    vi.mocked(ensureEmailProvider).mockReset()
    vi.mocked(deliver).mockReset().mockResolvedValue({ id: "accepted-1" })
    registerDeliveryCompletion("invoice", { pending: async () => true, delivered: async () => [], failed: mocks.failed, withdrawalReason: mocks.withdrawal })
  })

  it.each(["refused", "uncertain"])("reports %s delivery without email contents", async kind => {
    vi.mocked(deliver).mockRejectedValue(kind === "refused" ? new EmailSendError("validation_error", "private provider response") : new Error("private response"))
    await expect(handler(job())).rejects.toBeInstanceOf(TerminalJobError)
    expect(mocks.error).toHaveBeenCalledExactlyOnceWith("email.delivery_failed", {
      organizationId: "org-1", jobId: "job-1", kind: "invoice", provider: "smtp",
      outcome: kind === "refused" ? "rejected" : "unconfirmed", code: kind === "refused" ? "email_provider_refused" : null,
    })
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(mocks.failed).toHaveBeenCalledTimes(1)
  })

  it("reports delivery abandoned because the provider is unavailable", async () => {
    vi.mocked(ensureEmailProvider).mockImplementation(() => { throw new Error("unavailable") })
    await handler(job({ attempts: 4 }))
    expect(mocks.error).toHaveBeenCalledWith("email.delivery_failed", expect.objectContaining({ outcome: "withdrawn" }))
    expect(deliver).not.toHaveBeenCalled()
  })

  it("does not alert on successful or deliberately withdrawn mail", async () => {
    await handler(job())
    mocks.withdrawal.mockResolvedValue("Invoice already paid")
    await handler(job())
    expect(mocks.error).not.toHaveBeenCalled()
  })

  it("does not alert again when retrying settlement of a recorded refusal", async () => {
    const payload = { ...job().payload, decision: { reason: "rejected", code: "email_provider_refused", message: "safe" } }
    await expect(handler(job({ payload }))).rejects.toBeInstanceOf(TerminalJobError)
    expect(mocks.error).not.toHaveBeenCalled()
    expect(deliver).not.toHaveBeenCalled()
  })
})
