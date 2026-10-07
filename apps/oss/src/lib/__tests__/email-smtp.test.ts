import { afterEach, describe, expect, it, vi } from "vitest"
import { createServer, type Socket } from "node:net"
import { deliver, EmailSendError, ensureEmailProvider } from "../email"
import { readSmtpConfiguration, selectedEmailProvider } from "../email-provider-config"
import { getEmailDeliveryRuntimeStatus } from "../email-delivery"
import { resetRuntimePlatform, setRuntimePlatform } from "../runtime/platform"
import { buildQuitsAuthOptions } from "../runtime/auth-config"
import { readFileSync } from "node:fs"
import { parse as parseDotenv } from "dotenv"
import { isSmtpPreSubmissionFailure } from "../email-smtp-node"
import { betterAuth } from "better-auth"
import { memoryAdapter } from "better-auth/adapters/memory"
import { withSmtpDisconnect, withUntrustedSmtpTls } from "../../test-utils/__tests__/smtp"

afterEach(() => {
  vi.unstubAllEnvs()
  resetRuntimePlatform()
})

const message = { from: "Quits <billing@example.com>", to: "customer@example.com", subject: "Invoice 42", html: "<p>Amount €42</p>", replyTo: "reply@example.com" }

describe("SMTP configuration", () => {
  it("requires evidence of no submission and preserves unknown or post-DATA socket failures", () => {
    expect(isSmtpPreSubmissionFailure({ code: "EDNS", command: "CONN" })).toBe(true)
    expect(isSmtpPreSubmissionFailure({ code: "ESOCKET", command: "CONN", syscall: "connect" })).toBe(true)
    expect(isSmtpPreSubmissionFailure({ code: "ETIMEDOUT", command: "CONN", message: "Connection timeout" })).toBe(true)
    expect(isSmtpPreSubmissionFailure({ code: "ETIMEDOUT", command: "CONN", message: "Greeting never received" })).toBe(true)
    expect(isSmtpPreSubmissionFailure({ code: "ETIMEDOUT", command: "CONN", message: "Timeout" })).toBe(false)
    expect(isSmtpPreSubmissionFailure({ code: "ETIMEDOUT", command: "DATA", message: "Timeout" })).toBe(false)
    expect(isSmtpPreSubmissionFailure({ code: "ESOCKET", command: "CONN", syscall: "read" })).toBe(false)
    expect(isSmtpPreSubmissionFailure({ code: "ECONNECTION", command: "CONN" })).toBe(false)
    expect(isSmtpPreSubmissionFailure({ code: "ETIMEDOUT", message: "Greeting never received" })).toBe(false)
    expect(isSmtpPreSubmissionFailure(new Error("Unknown failure"))).toBe(false)
    expect(isSmtpPreSubmissionFailure({ code: "ETLS", command: "STARTTLS" })).toBe(true)
    expect(isSmtpPreSubmissionFailure({ code: "ETLS", command: "CONN" })).toBe(true)
    expect(isSmtpPreSubmissionFailure({ code: "ESOCKET", command: "CONN", message: "self signed certificate" })).toBe(false)
    expect(isSmtpPreSubmissionFailure({ code: "ESOCKET", command: "CONN", message: "self signed certificate" }, "connection")).toBe(true)
    expect(isSmtpPreSubmissionFailure({ code: "ETIMEDOUT", command: "CONN", message: "Timeout" }, "connection")).toBe(true)
    expect(isSmtpPreSubmissionFailure({ code: "ECONNECTION", command: "CONN" }, "connection")).toBe(true)
    expect(isSmtpPreSubmissionFailure({ code: "ESOCKET", command: "CONN" }, "data")).toBe(false)
    expect(isSmtpPreSubmissionFailure({ code: "ECONNECTION", command: "CONN" }, "data")).toBe(false)
  })
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

  it("uses port 465 when an operator selects implicit TLS in the example environment", () => {
    const example = parseDotenv(readFileSync(new URL("../../../../../.env.example", import.meta.url)))
    expect(readSmtpConfiguration({ ...example, SMTP_HOST: "relay.example", SMTP_SECURE: "true" })).toMatchObject({ port: 465, secure: true })
  })

  it("validates configuration and never exposes credentials in status", () => {
    expect(() => readSmtpConfiguration({})).toThrow("SMTP_HOST")
    for (const port of ["0", "65536", "12.5", "587abc"]) {
      expect(() => readSmtpConfiguration({ SMTP_HOST: "relay", SMTP_PORT: port })).toThrow("SMTP_PORT")
    }
    expect(() => readSmtpConfiguration({ SMTP_HOST: "relay", SMTP_SECURE: "yes" })).toThrow("SMTP_SECURE")
    expect(() => readSmtpConfiguration({ SMTP_HOST: "relay", SMTP_USER: "user" })).toThrow("SMTP_PASS")
    expect(() => readSmtpConfiguration({ SMTP_HOST: "relay", SMTP_PASS: "secret" })).toThrow("SMTP_USER")
    expect(() => readSmtpConfiguration({ SMTP_HOST: "relay", SMTP_PASSWORD: "secret" })).toThrow("SMTP_USER")
    expect(readSmtpConfiguration({ SMTP_HOST: "relay", SMTP_USER: "user", SMTP_PASS: "secret" })).toMatchObject({ auth: { user: "user", pass: "secret" } })
    expect(readSmtpConfiguration({ SMTP_HOST: "relay", SMTP_USER: "user", SMTP_PASSWORD: "secret" })).toMatchObject({ auth: { user: "user", pass: "secret" } })
    expect(readSmtpConfiguration({ SMTP_HOST: "relay", SMTP_USER: "user", SMTP_PASS: "canonical", SMTP_PASSWORD: "alias" })).toMatchObject({ auth: { pass: "canonical" } })
    expect(readSmtpConfiguration({ SMTP_HOST: "relay", SMTP_USER: "user", SMTP_PASS: "", SMTP_PASSWORD: "alias" })).toMatchObject({ auth: { pass: "alias" } })
    const status = getEmailDeliveryRuntimeStatus({ managed: false, emailProvider: "smtp", fromEmail: "a@example.com", smtp: { SMTP_HOST: "relay", SMTP_USER: "user", SMTP_PASS: "secret" } })
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

  it("reports complete SMTP configuration unavailable on Workers and keeps managed Resend available", () => {
    expect(getEmailDeliveryRuntimeStatus({ managed: false, runtimeKind: "worker", emailProvider: "smtp", fromEmail: "a@example.com", smtp: { SMTP_HOST: "relay" } })).toMatchObject({ configured: false, available: false, missing: ["EMAIL_PROVIDER"], status: "missing_configuration" })
    expect(getEmailDeliveryRuntimeStatus({ managed: true, runtimeKind: "worker", emailProvider: "resend", resendApiKey: "test-key", fromEmail: "a@example.com" })).toMatchObject({ configured: true, available: true, missing: [], status: "managed" })
  })
})

/** Disposable local relay, including the ambiguous disconnect after the body arrives. */
async function withRelay(mode: "accept" | "reject" | "partial" | "disconnect" | "greeting-timeout" | "malformed-auth" | "hold", run: (bodies: string[], commands: string[], release: () => void) => Promise<void>) {
  const bodies: string[] = []
  const commands: string[] = []
  const sockets = new Set<Socket>()
  const pending = new Set<Socket>()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
    if (mode !== "greeting-timeout") socket.write("220 local.test ESMTP\r\n")
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
          if (mode === "hold") pending.add(socket)
          else socket.write("250 queued as local-42\r\n")
        } else {
          const end = buffered.indexOf("\r\n")
          if (end < 0) return
          const line = buffered.slice(0, end)
          buffered = buffered.slice(end + 2)
          commands.push(line)
          if (/^EHLO/i.test(line) && mode === "malformed-auth") {
            // A bounded hostile whitespace run plus an invalid lookalike mechanism.
            // Patched Nodemailer must parse whole tokens and select only LOGIN.
            socket.write(`250-local.test\r\n250-AUTH ${" ".repeat(16_384)}X-PLAIN-SUFFIX\r\n250 AUTH=LOGIN\r\n`)
          } else if (/^EHLO/i.test(line)) socket.write("250-local.test\r\n250 8BITMIME\r\n")
          else if (/^AUTH/i.test(line) && mode === "malformed-auth") socket.write("535 credentials refused\r\n")
          else if (/^STARTTLS/i.test(line)) socket.write("454 TLS unavailable\r\n")
          else if (/^RCPT/i.test(line) && (mode === "reject" || (mode === "partial" && line.includes("customer@example.com")))) socket.write("550 recipient refused\r\n")
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
  vi.stubEnv("SMTP_PASS", "")
  vi.stubEnv("SMTP_PASSWORD", "")
  try { await run(bodies, commands, () => {
    for (const socket of pending) socket.write("250 queued as local-42\r\n")
    pending.clear()
  }) } finally {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

function recoveryAuth(environment: Record<string, string | undefined>) {
  const database: Record<string, Record<string, unknown>[]> = { user: [], session: [], account: [], verification: [] }
  const background: Promise<void>[] = []
  const origin = "http://localhost:3102"
  const options = buildQuitsAuthOptions({
    prisma: {
      $queryRaw: vi.fn().mockResolvedValue([{ count: 1 }]),
      $executeRaw: vi.fn().mockResolvedValue(0),
      $transaction: async (work: (tx: unknown) => Promise<unknown>) => work({ $queryRaw: vi.fn().mockResolvedValue([]) }),
    } as never,
    env: { getEnv: (name) => name === "BETTER_AUTH_URL" ? origin : environment[name] },
    hooks: {
      createDatabaseAdapter: () => memoryAdapter(database),
      createTransactionDatabaseAdapter: () => memoryAdapter(database),
      runInBackground: (task) => { background.push(task) },
    },
  })
  const auth = betterAuth({ ...options, secret: "smtp-recovery-test-secret-at-least-32-characters", logger: { disabled: true } })
  const post = (path: string, body: unknown) => auth.handler(new Request(`${origin}/api/auth${path}`, {
    method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify(body),
  }))
  return { database, background, origin, options, post }
}

describe("real SMTP transport", () => {
  it("recovers through the supplied SMTP environment while delivery is pending and global Resend has no key", async () => {
    await withRelay("hold", async (bodies, _commands, release) => {
      const environment = {
        EMAIL_PROVIDER: "smtp", SMTP_HOST: "127.0.0.1", SMTP_PORT: process.env.SMTP_PORT!,
        SMTP_SECURE: "false", SMTP_REQUIRE_TLS: "false", FROM_EMAIL: "initial@example.com",
      }
      vi.stubEnv("EMAIL_PROVIDER", "resend")
      vi.stubEnv("RESEND_API_KEY", "")
      vi.stubEnv("SMTP_HOST", "wrong-relay.invalid")
      vi.stubEnv("FROM_EMAIL", "process@example.com")
      const f = recoveryAuth(environment)
      // Keep the reader live after constructing auth rather than copying its configuration.
      environment.FROM_EMAIL = "reader@example.com"
      expect(f.options.plugins[0].options.disableOrganizationDeletion).toBe(true)
      expect((await f.post("/sign-up/email", { name: "Recovery User", email: "customer@example.com", password: "old-password123" })).status).toBe(200)
      try {
        const known = await f.post("/request-password-reset", { email: "customer@example.com", redirectTo: `${f.origin}/reset-password` })
        const unknown = await f.post("/request-password-reset", { email: "missing@example.com", redirectTo: `${f.origin}/reset-password` })
        expect(known.status).toBe(200)
        expect(await known.json()).toEqual(await unknown.json())
        await vi.waitFor(() => expect(bodies).toHaveLength(1))
        let settled = false
        f.background[0]!.then(() => { settled = true })
        await Promise.resolve()
        expect(settled).toBe(false)
        const token = (f.database.verification[0]!.identifier as string).slice("reset-password:".length)
        const rendered = bodies[0]!.replace(/=\r?\n/g, "").replace(/=3D/g, "=")
        expect(rendered).toContain("From: Quits <reader@example.com>")
        expect(rendered).toContain("Subject: Reset your Quits password")
        expect(rendered).toContain(`${f.origin}/api/auth/reset-password/${token}`)
        expect(rendered).not.toContain("process@example.com")
        release()
        await Promise.all(f.background)
        expect((await f.post("/reset-password", { token, newPassword: "new-password456" })).status).toBe(200)
        expect(f.database.verification).toHaveLength(0)
        expect(f.database.session).toHaveLength(0)
        expect((await f.post("/sign-in/email", { email: "customer@example.com", password: "old-password123" })).status).toBe(401)
        expect((await f.post("/sign-in/email", { email: "customer@example.com", password: "new-password456" })).status).toBe(200)
      } finally { release(); await Promise.all(f.background) }
    })
  })

  it.each([undefined, "", " \t "].map((fromEmail) => ({ fromEmail })))("keeps SMTP recovery generic without a supplied sender ($fromEmail)", async ({ fromEmail }) => {
    await withRelay("accept", async (bodies) => {
      const environment = {
        EMAIL_PROVIDER: "smtp", SMTP_HOST: "127.0.0.1", SMTP_PORT: process.env.SMTP_PORT!,
        SMTP_SECURE: "false", SMTP_REQUIRE_TLS: "false", FROM_EMAIL: fromEmail,
      }
      vi.stubEnv("EMAIL_PROVIDER", "resend")
      vi.stubEnv("RESEND_API_KEY", "")
      vi.stubEnv("FROM_EMAIL", "process@example.com")
      const logged = vi.spyOn(console, "error").mockImplementation(() => {})
      const f = recoveryAuth(environment)
      try {
        await f.post("/sign-up/email", { name: "Recovery User", email: "customer@example.com", password: "old-password123" })
        const known = await f.post("/request-password-reset", { email: "customer@example.com", redirectTo: `${f.origin}/reset-password` })
        const unknown = await f.post("/request-password-reset", { email: "missing@example.com", redirectTo: `${f.origin}/reset-password` })
        expect(known.status).toBe(200)
        expect(await known.json()).toEqual(await unknown.json())
        await Promise.all(f.background)
        expect(bodies).toHaveLength(0)
        expect(logged.mock.calls).toEqual([["Password reset email delivery failed"]])
      } finally { await Promise.all(f.background); logged.mockRestore() }
    })
  })


  it("processes bounded malformed EHLO AUTH padding and ignores lookalike mechanisms", async () => {
    await withRelay("malformed-auth", async (bodies, commands) => {
      vi.stubEnv("SMTP_USER", "test-user")
      vi.stubEnv("SMTP_PASS", "test-password")
      await expect(deliver(message)).rejects.toMatchObject({ providerCode: "smtp_rejected" })
      expect(commands.filter((command) => /^AUTH/i.test(command))).toEqual(["AUTH LOGIN"])
      expect(commands.some((command) => /^(?:MAIL|RCPT|DATA)\b/.test(command))).toBe(false)
      expect(bodies).toHaveLength(0)
    })
  }, 2_000)

  it.each(["before-greeting", "after-envelope"] as const)("rejects a relay close %s without submitting a message", async (mode) => {
    await withSmtpDisconnect(mode, async (environment, commands, bodies) => {
      await expect(deliver(message, { environment })).rejects.toMatchObject({ providerCode: "smtp_unavailable" })
      if (mode === "before-greeting") expect(commands).toHaveLength(0)
      else expect(commands.some((command) => command.startsWith("MAIL FROM:"))).toBe(true)
      expect(commands).not.toContain("DATA")
      expect(bodies).toHaveLength(0)
    })
  })

  it("keeps the same connection-close error ambiguous after DATA", async () => {
    await withSmtpDisconnect("after-data", async (environment, commands, bodies) => {
      const error = await deliver(message, { environment }).catch((failure: unknown) => failure)
      expect(error).toMatchObject({ code: "ECONNECTION", command: "CONN" })
      expect(error).not.toBeInstanceOf(EmailSendError)
      expect(commands).toContain("DATA")
      expect(bodies).toHaveLength(1)
    })
  })

  it.each(["starttls", "implicit"] as const)("rejects an untrusted %s certificate before submission", async (mode) => {
    await withUntrustedSmtpTls(mode, async (environment, commands) => {
      await expect(deliver(message, { environment })).rejects.toMatchObject({ name: "EmailSendError", providerCode: "smtp_unavailable" })
      expect(commands.some((command) => /^(?:MAIL|RCPT|DATA)\b/.test(command))).toBe(false)
      if (mode === "starttls") expect(commands).toContain("STARTTLS")
    })
  })

  it("reports a refused connection as definitely not submitted", async () => {
    const server = createServer()
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Expected a local port")
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await expect(deliver(message, { environment: { EMAIL_PROVIDER: "smtp", SMTP_HOST: "127.0.0.1", SMTP_PORT: String(address.port), SMTP_SECURE: "false", SMTP_REQUIRE_TLS: "false" } })).rejects.toMatchObject({ name: "EmailSendError", providerCode: "smtp_unavailable" })
  })

  it("reports a greeting timeout as definitely not submitted", async () => {
    await withRelay("greeting-timeout", async (bodies) => {
      await expect(deliver(message)).rejects.toMatchObject({ name: "EmailSendError", providerCode: "smtp_unavailable" })
      expect(bodies).toHaveLength(0)
    })
  })

  it("uses the independent auth environment for the provider, relay, and invitation sender", async () => {
    await withRelay("accept", async (bodies) => {
      const authEnvironment: Record<string, string> = {
        BETTER_AUTH_URL: "https://reader.example",
        EMAIL_PROVIDER: "smtp",
        SMTP_HOST: "127.0.0.1",
        SMTP_PORT: process.env.SMTP_PORT!,
        SMTP_SECURE: "false",
        SMTP_REQUIRE_TLS: "false",
        FROM_EMAIL: "reader@example.com",
      }
      // The auth reader is not registered as the runtime platform and differs from process.env.
      vi.stubEnv("EMAIL_PROVIDER", "resend")
      vi.stubEnv("RESEND_API_KEY", "")
      vi.stubEnv("SMTP_HOST", "wrong-relay.invalid")
      vi.stubEnv("FROM_EMAIL", "process@example.com")
      const options = buildQuitsAuthOptions({
        prisma: { orgSettings: { findUnique: vi.fn().mockResolvedValue({ locale: "en-US" }) } } as never,
        env: { getEnv: (name) => authEnvironment[name] },
      })
      await options.plugins[0].options.sendInvitationEmail({ id: "invite-reader", email: "customer@example.com", inviter: { user: { name: "Ada" } }, organization: { id: "org-reader", name: "Acme" } } as never)
      expect(bodies).toHaveLength(1)
      expect(bodies[0]).toContain("From: Quits <reader@example.com>")
      expect(bodies[0]).toContain("https://reader.example/accept-invitation/invite-reader")
      expect(bodies[0]).not.toContain("process@example.com")
    })
  })

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

  it("does not report success when the primary recipient is refused but CC is accepted", async () => {
    await withRelay("partial", async (bodies) => {
      await expect(deliver({ ...message, cc: "copy@example.com" })).rejects.toMatchObject({ name: "EmailSendError", providerCode: "smtp_partial_acceptance" })
      expect(bodies).toHaveLength(1)
      expect(bodies[0]).toContain("Cc: copy@example.com")
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
