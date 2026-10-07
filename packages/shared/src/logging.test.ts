import { describe, expect, it, vi } from "vitest"
import { createJsonLogger } from "./logging"

describe("json logger", () => {
  it("writes structured log entries to the provided sink", () => {
    const sink = vi.fn()
    const logger = createJsonLogger({
      service: "@quits/oss",
      sink,
      clock: () => new Date("2026-03-09T12:00:00.000Z"),
    })

    logger.info("invoice.email.sent", {
      invoiceId: "inv_123",
      sentAt: new Date("2026-03-09T11:59:00.000Z"),
    })

    expect(sink).toHaveBeenCalledOnce()
    const [line, entry] = sink.mock.calls[0] ?? []
    expect(line).toContain("\"event\":\"invoice.email.sent\"")
    expect(entry).toMatchObject({
      service: "@quits/oss",
      level: "info",
      event: "invoice.email.sent",
    })
  })

  it("serializes errors and child logger context", () => {
    const sink = vi.fn()
    const logger = createJsonLogger({
      service: "@quits/oss",
      sink,
    }).child("payments")

    logger.error("checkout.failed", {
      error: new Error("boom"),
    })

    const [, entry] = sink.mock.calls[0] ?? []
    expect(entry.context).toBe("payments")
    expect(entry.data).toMatchObject({
      error: {
        message: "boom",
        name: "Error",
      },
    })
  })
})
