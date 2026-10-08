import { createServerFn } from "@tanstack/react-start"
import { getCookie, getRequestHeaders, setCookie } from "@tanstack/react-start/server"
import { z } from "zod"
import { clientActionCodeSchema, clientActionRequestSchema } from "@quits/contracts/client-actions"
import { invalidLinkLocale } from "../documents/public-invalid-link"
import type { ClientActionDetail, ClientActionPage } from "./page"
import type { ClientActionOutcome } from "./actions"

const tokenSchema = z.string().min(1).max(4096)
/** Which record the visitor opened, as `kind:id`. */
const itemSchema = z.string().regex(/^(agreement|deliverable|invoice):[A-Za-z0-9_-]{1,100}$/)

export type ClientActionState =
  | { kind: "invalid"; locale: string }
  | { kind: "inactive"; reason: "expired" | "revoked"; seller: { name: string | null }; locale: string }
  | { kind: "ready"; page: ClientActionPage; detail: ClientActionDetail | null }

export function parseItem(item: string | undefined | null) {
  if (!item || !itemSchema.safeParse(item).success) return null
  const [kind, recordId] = item.split(":") as ["agreement" | "deliverable" | "invoice", string]
  return { kind, recordId }
}

/** Everything the page needs for one visit, decided from the link row on this request. */
export async function loadClientActionState(token: string, item: string | null | undefined): Promise<ClientActionState> {
  const [{ resolveClientActionAccess, touchClientActionLink }, { buildClientActionDetail, buildClientActionPage }, tokens] =
    await Promise.all([import("./access"), import("./page"), import("./tokens")])
  const now = new Date()
  const access = await resolveClientActionAccess(token, now)
  if (access.status === "invalid") return { kind: "invalid", locale: invalidLinkLocale() }
  if (access.status === "inactive") return { kind: "inactive", ...access }
  const { link } = access
  const verified = tokens.readVerifiedSession(getCookie(tokens.verifiedSessionCookieName(link.id)), link.id, now)
  void touchClientActionLink(link.id, now)
  const page = await buildClientActionPage(link, { token, verified, now })
  const ref = parseItem(item)
  const detail = ref ? await buildClientActionDetail(link, ref, token, now) : null
  return { kind: "ready", page, detail }
}

export const getClientActionState = createServerFn({ method: "GET" })
  .inputValidator(z.object({ token: tokenSchema, item: itemSchema.nullish() }).strict())
  .handler(({ data }) => loadClientActionState(data.token, data.item))

export type CodeRequestResult = { status: "sent" | "rate_limited" | "unavailable" | "inactive" }

export const requestClientActionCode = createServerFn({ method: "POST" })
  .inputValidator(z.object({ token: tokenSchema }).strict())
  .handler(async ({ data }): Promise<CodeRequestResult> => {
    const [{ resolveClientActionAccess }, { requestVerificationCode }, { buildClientActionPage }] = await Promise.all([
      import("./access"),
      import("./verification"),
      import("./page"),
    ])
    const access = await resolveClientActionAccess(data.token)
    if (access.status !== "active") return { status: "inactive" }
    const page = await buildClientActionPage(access.link, { token: data.token, verified: false })
    const status = await requestVerificationCode(access.link, { sellerName: page.seller.name, locale: page.locale })
    return { status }
  })

export type CodeCheckResult = { status: "verified" | "wrong" | "expired" | "locked" | "inactive" }

export const submitClientActionCode = createServerFn({ method: "POST" })
  .inputValidator(z.object({ token: tokenSchema, code: z.string().max(20) }).strict())
  .handler(async ({ data }): Promise<CodeCheckResult> => {
    const [access, verification, tokens] = await Promise.all([import("./access"), import("./verification"), import("./tokens")])
    const now = new Date()
    const resolved = await access.resolveClientActionAccess(data.token, now)
    if (resolved.status !== "active") return { status: "inactive" }
    const code = clientActionCodeSchema.safeParse(data.code)
    // Malformed input is a wrong guess: it takes an attempt like any other.
    const outcome = await verification.checkVerificationCode(resolved.link, code.success ? code.data : "000000x", now)
    if (outcome !== "verified") return { status: outcome }
    const until = new Date(
      Math.min(now.getTime() + verification.VERIFIED_SESSION_HOURS * 3_600_000, resolved.link.expiresAt.getTime()),
    )
    setCookie(tokens.verifiedSessionCookieName(resolved.link.id), tokens.mintVerifiedSession(resolved.link.id, until), {
      httpOnly: true,
      sameSite: "lax",
      secure: tokens.clientActionUrl("x").startsWith("https:"),
      path: "/",
      expires: until,
    })
    return { status: "verified" }
  })

export type SubmitClientActionResult = {
  outcome: ClientActionOutcome
  state: ClientActionState
}

export const submitClientAction = createServerFn({ method: "POST" })
  // Business validation follows the link check, so a dead link answers the same for any input.
  .inputValidator(z.object({ token: tokenSchema, request: z.unknown(), item: itemSchema.nullish() }).strict())
  .handler(async ({ data }): Promise<SubmitClientActionResult> => {
    const [access, actions, tokens] = await Promise.all([import("./access"), import("./actions"), import("./tokens")])
    const now = new Date()
    const resolved = await access.resolveClientActionAccess(data.token, now)
    let outcome: ClientActionOutcome
    if (resolved.status !== "active") {
      outcome = { status: "inactive" }
    } else {
      const parsed = clientActionRequestSchema.safeParse(data.request)
      if (!parsed.success) {
        outcome = { status: "not_permitted" }
      } else {
        const headers = getRequestHeaders()
        outcome = await actions.performClientAction(resolved.link, parsed.data, {
          token: data.token,
          verified: tokens.readVerifiedSession(getCookie(tokens.verifiedSessionCookieName(resolved.link.id)), resolved.link.id, now),
          evidence: {
            ip: headers.get("x-forwarded-for")?.split(",")[0]?.trim().slice(0, 200) ?? null,
            userAgent: headers.get("user-agent")?.slice(0, 1000) ?? null,
          },
          now,
        })
      }
    }
    return { outcome, state: await loadClientActionState(data.token, data.item) }
  })
