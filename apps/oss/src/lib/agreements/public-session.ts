import { createServerFn } from "@tanstack/react-start"
import { getRequestHeaders } from "@tanstack/react-start/server"
import { z } from "zod"
import { publicAgreementDto } from "./public"

export const getPublicAgreementSession = createServerFn({ method: "GET" })
  .inputValidator(z.object({ token: z.string().min(1).max(4096) }).strict())
  .handler(async ({ data }) => {
    const { loadPublicAgreementByToken } = await import("./public-access")
    const session = await loadPublicAgreementByToken(data.token)
    if (!session) return { kind: "invalid" } as const
    return {
      kind: "ready",
      document: publicAgreementDto(session.agreement),
      scope: session.payload.scope,
      readLink: null,
    } as const
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
      return { kind: "ready", ...result } as const
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : "invalid"
      if (code === "retry_later") return { kind: "retry_later" } as const
      if (code === "already_decided") return { kind: "already_decided" } as const
      return { kind: "invalid" } as const
    }
  })
