import { buildAbsoluteUrl, resolveAppOrigin } from "@quits/shared/http"
import { readFallbackSecret, readProductEnv } from "@quits/shared/runtimeEnv"
import { signQuotePublicToken } from "./public"

export function getPublicQuoteSecret() {
  const secret = readFallbackSecret(
    readProductEnv(process.env, "PUBLIC_QUOTE_SECRET"),
    process.env.BETTER_AUTH_SECRET
  )
  if (secret) {
    return secret
  }

  throw new Error("QUITS_PUBLIC_QUOTE_SECRET or BETTER_AUTH_SECRET must be configured")
}

export function getPublicQuoteUrl(quote: {
  id: string
  status: string
  publicAccessIssuedAt: Date | null
  publicAccessKeyVersion: number
}) {
  if (
    !quote.publicAccessIssuedAt ||
    (quote.status !== "sent" && quote.status !== "accepted" && quote.status !== "rejected")
  ) {
    return null
  }

  const origin = resolveAppOrigin(
    [readProductEnv(process.env, "APP_ORIGIN"), process.env.BETTER_AUTH_URL],
    ""
  )

  const token = signQuotePublicToken(
    {
      quoteId: quote.id,
      keyVersion: quote.publicAccessKeyVersion,
      scope: "quote_public",
    },
    getPublicQuoteSecret()
  )

  return buildAbsoluteUrl(origin, `/q/${encodeURIComponent(token)}`)
}
