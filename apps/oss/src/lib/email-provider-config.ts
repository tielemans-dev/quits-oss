import { getRuntimeEnv } from "./runtime/platform"

export type EmailProvider = "resend" | "smtp"
export type EmailEnvironment = Readonly<Record<string, string | undefined>>

export function selectedEmailProvider(value = getRuntimeEnv().EMAIL_PROVIDER): EmailProvider {
  if (!value || value === "resend") return "resend"
  if (value === "smtp") return "smtp"
  throw new Error("EMAIL_PROVIDER must be resend or smtp")
}

export class SmtpConfigurationError extends Error {
  constructor(readonly fields: string[], message: string) {
    super(message)
    this.name = "SmtpConfigurationError"
  }
}

function booleanSetting(env: EmailEnvironment, name: string, fallback: boolean) {
  const value = env[name]
  if (!value) return fallback
  if (value === "true") return true
  if (value === "false") return false
  throw new SmtpConfigurationError([name], `${name} must be true or false`)
}

/** Shared by the status screen and Node adapter; never returns secrets to a client. */
export function readSmtpConfiguration(env: EmailEnvironment = getRuntimeEnv()) {
  const host = env.SMTP_HOST?.trim()
  if (!host) throw new SmtpConfigurationError(["SMTP_HOST"], "SMTP_HOST is not configured")
  const secure = booleanSetting(env, "SMTP_SECURE", false)
  const port = env.SMTP_PORT ? Number(env.SMTP_PORT) : secure ? 465 : 587
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new SmtpConfigurationError(["SMTP_PORT"], "SMTP_PORT must be an integer between 1 and 65535")
  }
  const user = env.SMTP_USER?.trim()
  const pass = env.SMTP_PASSWORD
  if (Boolean(user) !== Boolean(pass)) {
    throw new SmtpConfigurationError(
      [user ? "SMTP_PASSWORD" : "SMTP_USER"],
      "SMTP_USER and SMTP_PASSWORD must be configured together"
    )
  }
  const requireTLS = booleanSetting(env, "SMTP_REQUIRE_TLS", true)
  return {
    host,
    port,
    secure,
    requireTLS: !secure && requireTLS,
    ...(user && pass ? { auth: { user, pass } } : {}),
    // Bounded below the outbox's timeout. Never disable certificate validation.
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
    disableFileAccess: true,
    disableUrlAccess: true,
  }
}
