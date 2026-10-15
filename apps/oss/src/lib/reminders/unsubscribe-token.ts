import { createHmac, timingSafeEqual } from "node:crypto"

export type ReminderRecipientBinding = { id: string; organizationId: string; recipient: string }

export function normalizeReminderRecipient(recipient: string) {
  return recipient.trim().toLowerCase()
}

/** Only a random preference ID is public. Organization, address and action are signed bindings. */
export function signReminderUnsubscribeToken(binding: ReminderRecipientBinding, secret: string) {
  const signature = createHmac("sha256", secret)
    .update(JSON.stringify(["automatic-reminders-unsubscribe-v1", binding.id, binding.organizationId, normalizeReminderRecipient(binding.recipient)]))
    .digest("base64url")
  return `v1.${binding.id}.${signature}`
}

export function reminderPreferenceId(token: string) {
  if (token.length !== 83) return null
  const match = /^v1\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/.exec(token)
  return match?.[1] ?? null
}

export function verifyReminderUnsubscribeToken(token: string, binding: ReminderRecipientBinding, secret: string) {
  if (reminderPreferenceId(token) !== binding.id) return false
  const expected = Buffer.from(signReminderUnsubscribeToken(binding, secret))
  const actual = Buffer.from(token)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
