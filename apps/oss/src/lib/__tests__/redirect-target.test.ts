import { describe, expect, it } from "vitest"
import { normalizeHostedNext, toInternalRedirectPath } from "../redirect-target"

describe("normalizeHostedNext", () => {
  it("accepts app.yaip.com same-origin paths", () => {
    expect(normalizeHostedNext("https://app.yaip.com/invoices/123", "https://app.yaip.com")).toBe(
      "https://app.yaip.com/invoices/123"
    )
  })

  it("rejects off-domain targets", () => {
    expect(normalizeHostedNext("https://evil.com/pwn", "https://app.yaip.com")).toBe(
      "https://app.yaip.com/"
    )
  })

  it("falls back when next is missing or invalid", () => {
    expect(normalizeHostedNext(undefined, "https://app.yaip.com")).toBe("https://app.yaip.com/")
    expect(normalizeHostedNext("/invoices", "https://app.yaip.com")).toBe("https://app.yaip.com/")
  })
})

describe("toInternalRedirectPath", () => {
  it("keeps same-site paths", () => {
    expect(toInternalRedirectPath("/invoices/1?tab=items")).toBe("/invoices/1?tab=items")
  })

  it("rejects external and protocol-relative targets", () => {
    expect(toInternalRedirectPath(undefined)).toBeNull()
    expect(toInternalRedirectPath("https://evil.example")).toBeNull()
    expect(toInternalRedirectPath("//evil.example")).toBeNull()
    expect(toInternalRedirectPath("/\\evil.example")).toBeNull()
    expect(toInternalRedirectPath("invoices")).toBeNull()
  })

  it("rejects paths a browser would resolve to another site", () => {
    for (const target of ["/\t/evil.example", "/\n/evil.example", "/\r/evil.example", "/\t\t/evil.example"]) {
      expect(toInternalRedirectPath(target)).toBeNull()
    }
  })

  it("returns the path as the browser resolves it", () => {
    expect(toInternalRedirectPath("/invoices/../quotes#top")).toBe("/quotes#top")
  })
})
