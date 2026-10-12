import { Effect } from "effect"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Prisma } from "../../../../generated/prisma/client"
const mock = vi.hoisted(() => ({ completions: new Map<string, { delivered: (input: unknown) => Promise<unknown> }>(), enqueue: vi.fn() }))
vi.mock("../../delivery/outbox", () => ({
  registerDeliveryCompletion: (kind: string, callback: { delivered: (input: unknown) => Promise<unknown> }) => mock.completions.set(kind, callback),
  enqueueEmailDelivery: mock.enqueue,
}))
vi.mock("../artifacts", () => ({ pendingCandidate: async () => true, publishCandidate: async () => [], retireCandidate: async () => [] }))
vi.mock("../locks", () => ({ lockInvoiceForCompletion: vi.fn() }))
import { queueDocumentEmail } from "../document-delivery"
import { Command } from "../../services"
beforeEach(() => { mock.enqueue.mockClear(); mock.enqueue.mockReturnValue(Effect.succeed({ deliveryKey: "synthetic" })) })
describe("agreement delivery language", () => {
  it.each([["da-DK", "Aftalen er sendt via e-mail."], ["en-US", "Agreement email sent."]])("carries the document locale through the outbox and records %s copy", async (locale, message) => {
    const markSending = vi.fn().mockResolvedValue({ id: "agreement" })
    await Effect.runPromise(queueDocumentEmail({ kind: "agreement", mode: "send", document: { id: "agreement", number: "AGR-1", locale }, recipient: "buyer@example.test", message: { from: "seller@example.test", to: "buyer@example.test", subject: "Synthetic", html: "Synthetic" }, idempotencyKey: "synthetic", markSending }).pipe(Effect.provideService(Command, { now: new Date("2026-10-12"), organizationId: "org" } as never)))
    const completion = mock.enqueue.mock.calls[0]![0].completion
    expect(completion.target.locale).toBe(locale)
    const update = vi.fn().mockResolvedValue({ count: 1 })
    const events = await mock.completions.get("agreement.send")!.delivered({ tx: { agreement: { updateMany: update } } as unknown as Prisma.TransactionClient, target: completion.target, organizationId: "org", commandId: "synthetic" })
    expect(update.mock.calls[0]![0].data).toMatchObject({ lastEmailAttemptOutcome: "sent", lastEmailAttemptCode: "sent", lastEmailAttemptMessage: message })
    expect(events).toMatchObject([{ type: "agreement.sent", payload: { number: "AGR-1", recipient: "buyer@example.test", emailSent: true } }])
  })
})
