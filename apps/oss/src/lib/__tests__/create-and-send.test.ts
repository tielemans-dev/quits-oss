import { describe, expect, it, vi } from "vitest"
import { createThenSend } from "../create-and-send"

describe("createThenSend", () => {
  it("only creates when not sending", async () => {
    const send = vi.fn()
    await expect(
      createThenSend({ create: async () => ({ id: "d_1" }), send, sendImmediately: false, sendFailedMessage: "x" })
    ).resolves.toEqual({ id: "d_1" })
    expect(send).not.toHaveBeenCalled()
  })

  it("passes on why the email was skipped", async () => {
    await expect(
      createThenSend({
        create: async () => ({ id: "d_1" }),
        send: async () => ({ emailSkipReason: "No email provider" }),
        sendImmediately: true,
        sendFailedMessage: "x",
      })
    ).resolves.toEqual({ id: "d_1", emailWarning: "No email provider" })
  })

  it("returns the created draft with the error when sending fails", async () => {
    const create = vi.fn(async () => ({ id: "d_1" }))
    await expect(
      createThenSend({
        create,
        send: async () => {
          throw new Error("The email provider refused the email")
        },
        sendImmediately: true,
        sendFailedMessage: "Failed to send",
      })
    ).resolves.toEqual({ id: "d_1", sendError: "The email provider refused the email" })
    expect(create).toHaveBeenCalledTimes(1)
  })

  it("falls back to the given message for errors without one", async () => {
    await expect(
      createThenSend({
        create: async () => ({ id: "d_1" }),
        send: () => Promise.reject("boom"),
        sendImmediately: true,
        sendFailedMessage: "Failed to send",
      })
    ).resolves.toEqual({ id: "d_1", sendError: "Failed to send" })
  })

  it("throws when creating fails", async () => {
    const send = vi.fn()
    await expect(
      createThenSend({
        create: async () => {
          throw new Error("invalid")
        },
        send,
        sendImmediately: true,
        sendFailedMessage: "x",
      })
    ).rejects.toThrow("invalid")
    expect(send).not.toHaveBeenCalled()
  })
})
