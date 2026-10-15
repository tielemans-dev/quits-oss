import { readFallbackSecret, readProductEnv } from "@quits/shared/runtimeEnv"
import { getRuntimeEnv } from "../runtime/platform"
import { localeFromAcceptLanguage } from "../i18n/accept-language"
import { normalizeReminderRecipient, reminderPreferenceId, verifyReminderUnsubscribeToken } from "./unsubscribe-token"
import type { Prisma } from "../../../generated/prisma/client"

export type ReminderPreferenceDb = Pick<Prisma.TransactionClient, "recipientReminderPreference" | "organization">

function unsubscribeSecret() {
  const env = getRuntimeEnv()
  const secret = readFallbackSecret(readProductEnv(env, "REMINDER_UNSUBSCRIBE_SECRET"), env.BETTER_AUTH_SECRET, 32)
  if (!secret) throw new Error("A reminder unsubscribe signing secret of at least 32 characters is required")
  return secret
}

export const REMINDER_UNSUBSCRIBED_MESSAGE = "The recipient unsubscribed from automatic reminders from this organization"

/** Only automatic reminders consult this preference, never direct sends or manual reminders. */
export async function automaticReminderSuppressed(db: Pick<ReminderPreferenceDb, "recipientReminderPreference">, organizationId: string, recipient: string, manual: boolean) {
  if (manual) return false
  const preference = await db.recipientReminderPreference.findUnique({
    where: { organizationId_recipient: { organizationId, recipient: normalizeReminderRecipient(recipient) } },
    select: { unsubscribedAt: true },
  })
  return preference?.unsubscribedAt != null
}

export const unsubscribeResponseHeaders = {
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
}

export type ReminderUnsubscribeState =
  | { kind: "invalid"; locale: string }
  | { kind: "confirm" | "done"; locale: string; organizationName: string }

/** GET is read-only. POST verifies the same recipient/organization/action binding again. */
export async function reminderUnsubscribeState(db: ReminderPreferenceDb, token: string, method: "GET" | "POST", acceptLanguage?: string | null): Promise<ReminderUnsubscribeState> {
  const invalid: ReminderUnsubscribeState = { kind: "invalid", locale: localeFromAcceptLanguage(acceptLanguage) }
  const id = reminderPreferenceId(token)
  if (!id) return invalid
  const preference = await db.recipientReminderPreference.findUnique({ where: { id } })
  if (!preference || !verifyReminderUnsubscribeToken(token, preference, unsubscribeSecret())) return invalid
  const organization = await db.organization.findUnique({ where: { id: preference.organizationId }, select: { name: true } })
  if (!organization) return invalid
  if (method === "POST") {
    // Conditional update preserves the first unsubscribe time and makes repeated POSTs harmless.
    await db.recipientReminderPreference.updateMany({
      where: { id: preference.id, organizationId: preference.organizationId, recipient: preference.recipient, unsubscribedAt: null },
      data: { unsubscribedAt: new Date() },
    })
  }
  return { kind: method === "POST" || preference.unsubscribedAt ? "done" : "confirm", locale: preference.locale, organizationName: organization.name }
}

export async function postReminderUnsubscribe(request: Request, db: ReminderPreferenceDb, oneClick: boolean) {
  const headers = new Headers(unsubscribeResponseHeaders)
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { ...unsubscribeResponseHeaders, Allow: "POST" } })
  const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase()
  if (contentType !== "application/x-www-form-urlencoded") return new Response(null, { status: 415, headers })
  // Small capability requests only. Do not log tokens or recipient addresses.
  const reader = request.body?.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  if (reader) {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 2048) {
        await reader.cancel()
        return new Response(null, { status: 413, headers })
      }
      chunks.push(value)
    }
  }
  const body = new TextDecoder().decode(Buffer.concat(chunks))
  const form = new URLSearchParams(body)
  if (oneClick && (form.get("List-Unsubscribe") !== "One-Click" || form.getAll("List-Unsubscribe").length !== 1)) return new Response(null, { status: 400, headers })
  const token = oneClick ? new URL(request.url).searchParams.get("token") ?? "" : form.get("token") ?? ""
  if (!oneClick && form.getAll("token").length !== 1) return new Response(null, { status: 400, headers })
  const state = await reminderUnsubscribeState(db, token, "POST", request.headers.get("accept-language"))
  if (state.kind === "invalid") {
    if (oneClick) return new Response(null, { status: 400, headers })
    headers.set("Location", "/reminders/unsubscribe")
    return new Response(null, { status: 303, headers })
  }
  if (oneClick) return new Response(null, { status: 204, headers })
  headers.set("Location", `/reminders/unsubscribe?token=${encodeURIComponent(token)}`)
  return new Response(null, { status: 303, headers })
}
