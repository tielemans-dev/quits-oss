import { getRuntimeCapabilities } from "../runtime/extensions"
import { createServerFn } from "@tanstack/react-start"
import { getRequestHeaders } from "@tanstack/react-start/server"
import { z } from "zod"
import { readAgreementOfferSnapshot } from "@quits/contracts/agreements"
import { invalidLinkLocale } from "../documents/public-invalid-link"
import { publicLogoPath } from "../documents/public-logo"
import { resolvePublicPresentation } from "../documents/public-presentation"
import type { loadPublicAgreementByToken } from "./public-access"
import { publicAgreementDto, publicDeliverableDto } from "./public"

/**
 * An agreement opened from a link, as its page shows it: in the language the offer was written in
 * and with the seller's identity, both through the same rules as the invoice and quote pages.
 * `token` is the link the page was opened with: an uploaded logo is served from its logo route.
 */
export function serializePublicAgreementSession(
  session: NonNullable<Awaited<ReturnType<typeof loadPublicAgreementByToken>>>,
  token: string,
) {
  const { agreement, payload } = session
  const snapshot = readAgreementOfferSnapshot(agreement.offerSnapshot)
  const { locale, seller } = resolvePublicPresentation({
    document: {
      locale: snapshot.locale,
      timezone: snapshot.timezone,
      sellerSnapshot: snapshot.sellerSnapshot,
    },
    settings: agreement.organization?.settings,
    logoPath: publicLogoPath("a", token),
  })
  if (payload.scope === "sign_off") {
    const line = agreement.deliverables.find((current) => current.id === payload.deliverableId)!
    return {
      kind: "ready",
      scope: "sign_off",
      locale,
      seller,
      deliverable: publicDeliverableDto(agreement, line),
    } as const
  }
  return {
    kind: "ready",
    scope: payload.scope,
    locale,
    seller,
    document: publicAgreementDto(agreement),
    readLink: null,
    depositsEnabled: getRuntimeCapabilities().agreements.depositsEnabled,
  } as const
}

export const getPublicAgreementSession = createServerFn({ method: "GET" })
  .inputValidator(z.object({ token: z.string().min(1).max(4096) }).strict())
  .handler(async ({ data }) => {
    const { loadPublicAgreementByToken } = await import("./public-access")
    const session = await loadPublicAgreementByToken(data.token)
    if (!session) {
      // No document to take a language from: answer in the visitor's.
      return { kind: "invalid", locale: invalidLinkLocale() } as const
    }
    return serializePublicAgreementSession(session, data.token)
  })
export const submitPublicAgreementDecision = createServerFn({ method: "POST" })
  // Business validation follows the rate limiter, so refused decisions still count.
  .inputValidator(z.object({ token: z.string().min(1).max(4096), decision: z.unknown() }).strict())
  .handler(async ({ data }) => {
    try {
      const { decidePublicAgreementByToken } = await import("./public-access")
      const headers = getRequestHeaders()
      const result = await decidePublicAgreementByToken(data.token, data.decision, {
        ip: headers.get("x-forwarded-for")?.split(",")[0]?.trim().slice(0, 200) ?? null,
        userAgent: headers.get("user-agent")?.slice(0, 1000) ?? null,
      })
      return { kind: "ready", ...result, depositsEnabled: getRuntimeCapabilities().agreements.depositsEnabled } as const
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : "invalid"
      if (code === "deposits_disabled") return { kind: "deposits_disabled" } as const
      if (code === "retry_later") return { kind: "retry_later" } as const
      if (code === "already_decided") return { kind: "already_decided" } as const
      return { kind: "invalid" } as const
    }
  })

export const submitPublicDeliverableDecision = createServerFn({ method: "POST" })
  .inputValidator(z.object({ token: z.string().min(1).max(4096), decision: z.unknown() }).strict())
  .handler(async ({ data }) => {
    try {
      const { decidePublicDeliverableByToken } = await import("./public-access")
      return { kind: "ready", ...await decidePublicDeliverableByToken(data.token, data.decision) } as const
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : "invalid"
      if (code === "retry_later") return { kind: "retry_later" } as const
      if (code === "already_decided") return { kind: "already_decided" } as const
      return { kind: "invalid" } as const
    }
  })
