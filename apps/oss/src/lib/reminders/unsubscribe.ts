import { randomUUID } from "node:crypto"
import { buildAbsoluteUrl, resolveAppOrigin } from "@quits/shared/http"
import { readFallbackSecret, readProductEnv } from "@quits/shared/runtimeEnv"
import { getRuntimeEnv } from "../runtime/platform"
import { escapeHtml } from "../email"
import { translate } from "../i18n/translate"
import { localeFromAcceptLanguage } from "../i18n/accept-language"
import { appLogger } from "../observability"
import { normalizeReminderRecipient, reminderPreferenceId, signReminderUnsubscribeToken, verifyReminderUnsubscribeToken } from "./unsubscribe-token"
import type { Prisma } from "../../../generated/prisma/client"
import type { StoredEmailMessage } from "../../domain/delivery/outbox"

export type ReminderPreferenceDb = Pick<Prisma.TransactionClient, "recipientReminderPreference" | "organization">

function unsubscribeSecret() {
  const env = getRuntimeEnv()
  const secret = readFallbackSecret(readProductEnv(env, "REMINDER_UNSUBSCRIBE_SECRET"), env.BETTER_AUTH_SECRET, 32)
  if (!secret) throw new Error("A reminder unsubscribe signing secret of at least 32 characters is required")
  return secret
}

let warnedMissingOrigin = false

/** Persist the binding in the sending transaction. Resends never reset an unsubscribe. */
export async function addReminderUnsubscribe(input: {
  db: ReminderPreferenceDb
  organizationId: string
  locale: string
  message: StoredEmailMessage
}) {
  const env = getRuntimeEnv()
  const origin = resolveAppOrigin([readProductEnv(env, "APP_ORIGIN"), env.BETTER_AUTH_URL])
  if (!/^https?:\/\//.test(origin)) {
    if (!warnedMissingOrigin) appLogger.warn("reminders.unsubscribe_origin_missing")
    warnedMissingOrigin = true
    return input.message
  }
  const recipient = normalizeReminderRecipient(input.message.to)
  const preference = await input.db.recipientReminderPreference.upsert({
    where: { organizationId_recipient: { organizationId: input.organizationId, recipient } },
    create: { id: randomUUID(), organizationId: input.organizationId, recipient, locale: input.locale },
    update: { locale: input.locale },
  })
  const token = signReminderUnsubscribeToken(preference, unsubscribeSecret())
  const pageUrl = buildAbsoluteUrl(origin, `/reminders/unsubscribe?token=${encodeURIComponent(token)}`)
  const oneClickUrl = buildAbsoluteUrl(origin, `/api/reminders/unsubscribe?token=${encodeURIComponent(token)}`)
  const footer = `<p style="margin:12px 0 0;font-size:12px;"><a href="${escapeHtml(pageUrl)}">${escapeHtml(translate("email.reminderUnsubscribe.link", input.locale))}</a><br />${escapeHtml(translate("email.reminderUnsubscribe.scope", input.locale))}</p>`
  return {
    ...input.message,
    html: input.message.html.replace("</body>", () => `${footer}</body>`),
    headers: {
      ...input.message.headers,
      "List-Unsubscribe": `<${oneClickUrl.startsWith("https:") ? oneClickUrl : pageUrl}>`,
      // RFC 8058 requires HTTPS. HTTP self-hosters keep the explicit confirmation link.
      ...(oneClickUrl.startsWith("https:") ? { "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } : {}),
    },
  }
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

async function verifiedReminderPreference(db: ReminderPreferenceDb, token: string) {
  const id = reminderPreferenceId(token)
  if (!id) return null
  const preference = await db.recipientReminderPreference.findUnique({ where: { id } })
  if (!preference || !verifyReminderUnsubscribeToken(token, preference, unsubscribeSecret())) return null
  const organization = await db.organization.findUnique({ where: { id: preference.organizationId }, select: { name: true } })
  return organization ? { preference, organization } : null
}

/** The public GET loader has no mutation path, including in the production bundle. */
export async function readReminderUnsubscribeState(db: ReminderPreferenceDb, token: string, acceptLanguage?: string | null): Promise<ReminderUnsubscribeState> {
  const binding = await verifiedReminderPreference(db, token)
  if (!binding) return { kind: "invalid", locale: localeFromAcceptLanguage(acceptLanguage) }
  const { preference, organization } = binding
  return { kind: preference.unsubscribedAt ? "done" : "confirm", locale: preference.locale, organizationName: organization.name }
}

/** POST revalidates the recipient/organization/action binding before writing. */
export async function reminderUnsubscribeState(db: ReminderPreferenceDb, token: string, method: "POST", acceptLanguage?: string | null): Promise<ReminderUnsubscribeState> {
  const binding = await verifiedReminderPreference(db, token)
  if (!binding) return { kind: "invalid", locale: localeFromAcceptLanguage(acceptLanguage) }
  const { preference, organization } = binding
  if (method === "POST") {
    // Conditional update preserves the first unsubscribe time and makes repeated POSTs harmless.
    await db.recipientReminderPreference.updateMany({
      where: { id: preference.id, organizationId: preference.organizationId, recipient: preference.recipient, unsubscribedAt: null },
      data: { unsubscribedAt: new Date() },
    })
  }
  return { kind: "done", locale: preference.locale, organizationName: organization.name }
}

export async function postReminderUnsubscribe(request: Request, db: ReminderPreferenceDb, oneClick: boolean) {
  const headers = new Headers(unsubscribeResponseHeaders)
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { ...unsubscribeResponseHeaders, Allow: "POST" } })
  const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase()
  if (contentType !== "application/x-www-form-urlencoded" && contentType !== "multipart/form-data") return new Response(null, { status: 415, headers })
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
  const bytes = new Uint8Array(Buffer.concat(chunks))
  let form: URLSearchParams
  try {
    if (contentType === "multipart/form-data") {
      const multipart = await new Response(bytes, { headers: request.headers }).formData()
      form = new URLSearchParams()
      for (const [name, value] of multipart) {
        if (typeof value !== "string") return new Response(null, { status: 400, headers })
        form.append(name, value)
      }
    } else {
      form = new URLSearchParams(new TextDecoder().decode(bytes))
    }
  } catch {
    return new Response(null, { status: 400, headers })
  }
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
