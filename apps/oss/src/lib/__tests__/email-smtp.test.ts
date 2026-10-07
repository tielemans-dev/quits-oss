import { afterEach, describe, expect, it, vi } from "vitest"
import { createServer, type Socket } from "node:net"
import { deliver, EmailSendError, ensureEmailProvider } from "../email"
import { readSmtpConfiguration, selectedEmailProvider } from "../email-provider-config"
import { getEmailDeliveryRuntimeStatus } from "../email-delivery"
import { resetRuntimePlatform, setRuntimePlatform } from "../runtime/platform"

afterEach(() => {
  vi.unstubAllEnvs()
  resetRuntimePlatform()
})

const message = { from: "Quits <billing@example.com>", to: "customer@example.com", subject: "Invoice 42", html: "<p>Amount €42</p>", replyTo: "reply@example.com" }

describe("SMTP configuration", () => {
  it("keeps Resend as the default and rejects unknown providers", () => {
    expect(selectedEmailProvider("")).toBe("resend")
    expect(selectedEmailProvider("smtp")).toBe("smtp")
    expect(() => selectedEmailProvider("smtpp")).toThrow("EMAIL_PROVIDER")
  })

  it("requires STARTTLS by default and uses port 465 for implicit TLS", () => {
    expect(readSmtpConfiguration({ SMTP_HOST: "relay.example" })).toMatchObject({ port: 587, secure: false, requireTLS: true })
    expect(readSmtpConfiguration({ SMTP_HOST: "relay.example", SMTP_SECURE: "true" })).toMatchObject({ port: 465, secure: true, requireTLS: false })
    expect(readSmtpConfiguration({ SMTP_HOST: "relay.example", SMTP_REQUIRE_TLS: "false" })).toMatchObject({ requireTLS: false })
  })

  it("validates configuration and never exposes credentials in status", () => {
    expect(() => readSmtpConfiguration({})).toThrow("SMTP_HOST")
    for (const port of ["0", "65536", "12.5", "587abc"]) {
      expect(() => readSmtpConfiguration({ SMTP_HOST: "relay", SMTP_PORT: port })).toThrow("SMTP_PORT")
    }
    expect(() => readSmtpConfiguration({ SMTP_HOST: "relay", SMTP_SECURE: "yes" })).toThrow("SMTP_SECURE")
    expect(() => readSmtpConfiguration({ SMTP_HOST: "relay", SMTP_USER: "user" })).toThrow("SMTP_PASSWORD")
    expect(() => readSmtpConfiguration({ SMTP_HOST: "relay", SMTP_PASSWORD: "secret" })).toThrow("SMTP_USER")
    expect(readSmtpConfiguration({ SMTP_HOST: "relay", SMTP_USER: "user", SMTP_PASSWORD: "secret" })).toMatchObject({ auth: { user: "user", pass: "secret" } })
    const status = getEmailDeliveryRuntimeStatus({ managed: false, emailProvider: "smtp", fromEmail: "a@example.com", smtp: { SMTP_HOST: "relay", SMTP_USER: "user", SMTP_PASSWORD: "secret" } })
    expect(status).toMatchObject({ available: true, missing: [] })
    expect(JSON.stringify(status)).not.toContain("secret")
    expect(getEmailDeliveryRuntimeStatus({ managed: false, emailProvider: "smtp", fromEmail: "a@example.com" })).toMatchObject({ available: false, missing: ["SMTP_HOST"] })
    expect(getEmailDeliveryRuntimeStatus({ managed: false, emailProvider: "unknown", fromEmail: "a@example.com" })).toMatchObject({ available: false, missing: ["EMAIL_PROVIDER"] })
  })

  it("refuses SMTP on Workers before loading the Node adapter", () => {
    vi.stubEnv("EMAIL_PROVIDER", "smtp")
    setRuntimePlatform({ id: "test-worker", getRuntimeKind: () => "worker", getEnv: (name) => process.env[name], getBinding: () => undefined, getPrisma: () => undefined, getAuthHooks: () => ({}) })
    expect(() => ensureEmailProvider()).toThrow("Node/Bun")
  })
})

/** Disposable local relay, including the ambiguous disconnect after the body arrives. */
async function withRelay(mode: "accept" | "reject" | "disconnect", run: (bodies: string[]) => Promise<void>) {
  const bodies: string[] = []
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
    socket.write("220 local.test ESMTP\r\n")
    let buffered = ""
    let inData = false
    socket.on("data", (chunk) => {
      buffered += chunk.toString()
      for (;;) {
        if (inData) {
          const end = buffered.indexOf("\r\n.\r\n")
          if (end < 0) return
          bodies.push(buffered.slice(0, end))
          buffered = buffered.slice(end + 5)
          inData = false
          if (mode === "disconnect") { socket.destroy(); return }
          socket.write("250 queued as local-42\r\n")
        } else {
          const end = buffered.indexOf("\r\n")
          if (end < 0) return
          const line = buffered.slice(0, end)
          buffered = buffered.slice(end + 2)
          if (/^EHLO/i.test(line)) socket.write("250-local.test\r\n250 8BITMIME\r\n")
          else if (/^STARTTLS/i.test(line)) socket.write("454 TLS unavailable\r\n")
          else if (/^RCPT/i.test(line) && mode === "reject") socket.write("550 recipient refused\r\n")
          else if (/^DATA/i.test(line)) { inData = true; socket.write("354 send message\r\n") }
          else if (/^QUIT/i.test(line)) socket.end("221 bye\r\n")
          else socket.write("250 OK\r\n")
        }
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Expected a local relay port")
  vi.stubEnv("EMAIL_PROVIDER", "smtp")
  vi.stubEnv("SMTP_HOST", "127.0.0.1")
  vi.stubEnv("SMTP_PORT", String(address.port))
  vi.stubEnv("SMTP_SECURE", "false")
  vi.stubEnv("SMTP_REQUIRE_TLS", "false")
  vi.stubEnv("SMTP_USER", "")
  vi.stubEnv("SMTP_PASSWORD", "")
  try { await run(bodies) } finally {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

describe("real SMTP transport", () => {
  it("sends a rendered message and returns its message id", async () => {
    await withRelay("accept", async (bodies) => {
      await expect(deliver(message, { idempotencyKey: "smtp-smoke-42" })).resolves.toMatchObject({ id: expect.stringContaining("@example.com>") })
      expect(bodies).toHaveLength(1)
      expect(bodies[0]).toContain("Reply-To: reply@example.com")
      expect(bodies[0]).toContain("Subject: Invoice 42")
      expect(bodies[0]).toContain("<p>Amount =E2=82=AC42</p>")
    })
  })

  it("turns an explicit recipient refusal into a definite rejection", async () => {
    await withRelay("reject", async (bodies) => {
      await expect(deliver(message)).rejects.toMatchObject({ name: "EmailSendError", providerCode: "smtp_rejected" })
      expect(bodies).toHaveLength(0)
    })
  })

  it("keeps a disconnect after DATA ambiguous", async () => {
    await withRelay("disconnect", async (bodies) => {
      const error = await deliver(message).catch((error: unknown) => error)
      expect(error).toBeInstanceOf(Error)
      expect(error).not.toBeInstanceOf(EmailSendError)
      expect(bodies).toHaveLength(1)
    })
  })

  it("requires STARTTLS unless explicitly disabled", async () => {
    await withRelay("accept", async (bodies) => {
      vi.stubEnv("SMTP_REQUIRE_TLS", "true")
      await expect(deliver(message)).rejects.toBeInstanceOf(Error)
      expect(bodies).toHaveLength(0)
    })
  })
})
