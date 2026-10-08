import { createHmac } from "node:crypto"
import { readFallbackSecret, readProductEnv } from "@quits/shared/runtimeEnv"
import { decryptSecret } from "../../lib/secrets"
import { ENCRYPTED_COLUMNS } from "./format"

type Env = Record<string, string | undefined>

/** The keys a restored installation needs unchanged: encrypted settings and every public link. */
export const KEY_NAMES = ["BETTER_AUTH_SECRET", "PUBLIC_PAYMENT_SECRET", "PUBLIC_QUOTE_SECRET", "PUBLIC_AGREEMENT_SECRET"] as const

/** The secret the application actually uses for `name`, following its own fallback to the auth secret. */
function effectiveSecret(env: Env, name: (typeof KEY_NAMES)[number]) {
  const auth = env.BETTER_AUTH_SECRET
  if (name === "BETTER_AUTH_SECRET") return auth?.trim() && auth.trim().length >= 16 ? auth.trim() : null
  return readFallbackSecret(readProductEnv(env, name), auth)
}

/**
 * A short keyed digest that tells whether two installations hold the same key. It is an HMAC
 * under the key itself, so it cannot be used to recover the key and is not the key's hash.
 */
export function keyFingerprint(secret: string) {
  return createHmac("sha256", secret).update("quits-backup-key-fingerprint-v1").digest("hex").slice(0, 16)
}

export function keyFingerprints(env: Env): Record<string, string | null> {
  return Object.fromEntries(
    KEY_NAMES.map((name) => {
      const secret = effectiveSecret(env, name)
      return [name, secret ? keyFingerprint(secret) : null]
    })
  )
}

const envName = (name: string) => (name === "BETTER_AUTH_SECRET" ? name : `QUITS_${name}`)

export type KeyFinding = { code: "missing_key" | "wrong_key"; key: string; message: string; action: string }

/** Compares the keys in `env` with the fingerprints a bundle recorded. */
export function compareKeys(recorded: Record<string, string | null>, env: Env): KeyFinding[] {
  const current = keyFingerprints(env)
  const findings: KeyFinding[] = []
  for (const [name, fingerprint] of Object.entries(recorded)) {
    if (fingerprint === null) continue
    // A link secret that was only the auth secret's fallback is covered by the auth secret's finding.
    if (name !== "BETTER_AUTH_SECRET" && fingerprint === recorded.BETTER_AUTH_SECRET) {
      const auth = current.BETTER_AUTH_SECRET
      if (auth === null || auth !== recorded.BETTER_AUTH_SECRET) continue
    }
    if (current[name] == null) {
      findings.push({
        code: "missing_key",
        key: name,
        message: `${envName(name)} is not set, but the backup was made with it.`,
        action: `Set ${envName(name)} to the value the source installation used.`,
      })
    } else if (current[name] !== fingerprint) {
      findings.push({
        code: "wrong_key",
        key: name,
        message: `${envName(name)} differs from the key the backup was made with.`,
        action: "Use the original value. Encrypted settings and issued public links stop working with a different key.",
      })
    }
  }
  return findings
}

/**
 * Counts stored values that the running process's `BETTER_AUTH_SECRET` cannot decrypt. The
 * decrypted text is discarded immediately and never logged.
 */
export function countUndecryptable(values: readonly string[]) {
  let failed = 0
  for (const value of values) {
    try {
      decryptSecret(value)
    } catch {
      failed += 1
    }
  }
  return failed
}

export const encryptedColumnList = ENCRYPTED_COLUMNS

/** Settings a recovered installation relies on. Names and whether they are set; never values. */
export function configurationInventory(env: Env) {
  const has = (name: string) => Boolean(env[name]?.trim())
  const product = (name: string) => Boolean(readProductEnv(env, name)?.trim())
  const provider = env.EMAIL_PROVIDER === "smtp" ? "smtp" : "resend"
  return [
    { name: "DATABASE_URL", set: has("DATABASE_URL"), purpose: "PostgreSQL connection" },
    { name: "BETTER_AUTH_SECRET", set: has("BETTER_AUTH_SECRET"), purpose: "Signs sessions and decrypts stored provider secrets" },
    { name: "BETTER_AUTH_URL", set: has("BETTER_AUTH_URL"), purpose: "Public address used in links" },
    { name: "CRON_SECRET", set: has("CRON_SECRET"), purpose: "Authorizes the scheduler tick and status endpoint" },
    { name: "QUITS_PUBLIC_PAYMENT_SECRET", set: product("PUBLIC_PAYMENT_SECRET"), purpose: "Signs public payment links (falls back to BETTER_AUTH_SECRET)" },
    { name: "QUITS_PUBLIC_QUOTE_SECRET", set: product("PUBLIC_QUOTE_SECRET"), purpose: "Signs public quote links (falls back to BETTER_AUTH_SECRET)" },
    { name: "QUITS_PUBLIC_AGREEMENT_SECRET", set: product("PUBLIC_AGREEMENT_SECRET"), purpose: "Signs public agreement links (falls back to BETTER_AUTH_SECRET)" },
    { name: "QUITS_ARTIFACT_DIR", set: product("ARTIFACT_DIR"), purpose: "Directory of issued PDFs and e-invoices" },
    { name: "EMAIL_PROVIDER", set: has("EMAIL_PROVIDER"), purpose: "Email provider: resend or smtp" },
    provider === "smtp"
      ? { name: "SMTP_HOST", set: has("SMTP_HOST"), purpose: "SMTP relay for outgoing email" }
      : { name: "RESEND_API_KEY", set: has("RESEND_API_KEY"), purpose: "Resend credentials for outgoing email" },
    { name: "FROM_EMAIL", set: has("FROM_EMAIL"), purpose: "Sender address for outgoing email" },
  ]
}
