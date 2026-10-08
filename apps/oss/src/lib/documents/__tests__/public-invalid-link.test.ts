import { beforeEach, describe, expect, it, vi } from "vitest"

const server = vi.hoisted(() => ({
  headers: new Map<string, string>(),
  acceptLanguage: undefined as string | undefined,
}))

vi.mock("@tanstack/react-start/server", () => ({
  getRequestHeader: (name: string) => (name === "accept-language" ? server.acceptLanguage : undefined),
  setResponseHeader: (name: string, value: string) => server.headers.set(name.toLowerCase(), value),
}))

import { invalidLinkLocale } from "../public-invalid-link"

describe("invalidLinkLocale", () => {
  beforeEach(() => {
    server.headers.clear()
    server.acceptLanguage = undefined
  })

  it("answers in the visitor's language", () => {
    server.acceptLanguage = "da-DK,da;q=0.9,en;q=0.8"

    expect(invalidLinkLocale()).toBe("da-DK")
  })

  it("says the answer depends on the visitor's language and keeps it out of caches", () => {
    invalidLinkLocale()

    expect(server.headers.get("vary")).toBe("Accept-Language")
    expect(server.headers.get("cache-control")).toBe("private, no-store")
  })
})
