import { afterEach, describe, expect, it } from "vitest"
import { getPublicQuoteUrl } from "../quotes/public-url"

describe("getPublicQuoteUrl", () => {
  const originalOrigin = process.env.QUITS_APP_ORIGIN
  const originalAuthUrl = process.env.BETTER_AUTH_URL
  const originalSecret = process.env.QUITS_PUBLIC_QUOTE_SECRET
  const originalAuthSecret = process.env.BETTER_AUTH_SECRET

  afterEach(() => {
    process.env.QUITS_APP_ORIGIN = originalOrigin
    process.env.BETTER_AUTH_URL = originalAuthUrl
    process.env.QUITS_PUBLIC_QUOTE_SECRET = originalSecret
    process.env.BETTER_AUTH_SECRET = originalAuthSecret
  })

  it("builds a public quote URL for a sent quote", () => {
    process.env.QUITS_APP_ORIGIN = "https://app.example.test"
    process.env.QUITS_PUBLIC_QUOTE_SECRET = "public-quote-secret-1234"

    const url = getPublicQuoteUrl({
      id: "quote-123",
      status: "sent",
      publicAccessIssuedAt: new Date("2026-03-05T12:00:00.000Z"),
      publicAccessKeyVersion: 2,
    })

    expect(url).toContain("https://app.example.test/q/")
    expect(url).toContain("cXVvdGUtMTIz")
  })

  it("returns null when the quote has not been issued for public access", () => {
    process.env.QUITS_APP_ORIGIN = "https://app.example.test"
    process.env.QUITS_PUBLIC_QUOTE_SECRET = "public-quote-secret-1234"

    const url = getPublicQuoteUrl({
      id: "quote-123",
      status: "draft",
      publicAccessIssuedAt: null,
      publicAccessKeyVersion: 1,
    })

    expect(url).toBeNull()
  })
})
