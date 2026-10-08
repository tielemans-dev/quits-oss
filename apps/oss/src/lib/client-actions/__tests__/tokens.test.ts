import { afterEach, describe, expect, it, vi } from "vitest"
import {
  codesMatch,
  getClientActionSecret,
  hashVerificationCode,
  mintClientActionToken,
  mintVerifiedSession,
  readVerifiedSession,
  verifiedSessionCookieName,
  verifyClientActionToken,
} from "../tokens"

const secret = "client-action-test-secret-over-32-characters"
const now = new Date("2026-10-08T12:00:00Z")

afterEach(() => vi.unstubAllEnvs())

describe("recovery key contract", () => {
  it("resolves the current name, legacy name, then auth fallback", () => {
    vi.stubEnv("BETTER_AUTH_SECRET", "auth-fallback-secret")
    vi.stubEnv("YAIP_PUBLIC_CLIENT_ACTION_SECRET", "legacy-secret-key")
    vi.stubEnv("QUITS_PUBLIC_CLIENT_ACTION_SECRET", "current-secret-key")
    expect(getClientActionSecret()).toBe("current-secret-key")
    vi.stubEnv("QUITS_PUBLIC_CLIENT_ACTION_SECRET", "")
    expect(getClientActionSecret()).toBe("auth-fallback-secret")
    vi.stubEnv("QUITS_PUBLIC_CLIENT_ACTION_SECRET", undefined)
    expect(getClientActionSecret()).toBe("legacy-secret-key")
    vi.stubEnv("YAIP_PUBLIC_CLIENT_ACTION_SECRET", undefined)
    expect(getClientActionSecret()).toBe("auth-fallback-secret")
  })

  it("invalidates links, pending codes and browser sessions when the effective key changes", () => {
    const rotated = "replacement-recovery-key"
    const session = mintVerifiedSession("link_1", new Date(now.getTime() + 60_000), secret)
    expect(verifyClientActionToken(mintClientActionToken("link_1", secret), rotated)).toBeNull()
    expect(codesMatch(hashVerificationCode("link_1", "123456", secret), "link_1", "123456", rotated)).toBe(false)
    expect(readVerifiedSession(session, "link_1", now, rotated)).toBe(false)
  })
})

describe("client action tokens", () => {
  it("names the link and rejects any other signature or secret", () => {
    const token = mintClientActionToken("link_1", secret)
    expect(verifyClientActionToken(token, secret)).toBe("link_1")
    expect(verifyClientActionToken(token, "another-secret-over-32-characters-long")).toBeNull()
    expect(verifyClientActionToken(token.replace("link_1", "link_2"), secret)).toBeNull()
    expect(verifyClientActionToken(`${token}.extra`, secret)).toBeNull()
    expect(verifyClientActionToken("link_1.", secret)).toBeNull()
    expect(verifyClientActionToken("", secret)).toBeNull()
    expect(verifyClientActionToken(`${"x".repeat(101)}.sig`, secret)).toBeNull()
  })

  it("does not accept a link token where a verified session is expected, or the reverse", () => {
    const session = mintVerifiedSession("link_1", new Date(now.getTime() + 60_000), secret)
    expect(verifyClientActionToken(session, secret)).toBeNull()
    expect(readVerifiedSession(mintClientActionToken("link_1", secret), "link_1", now, secret)).toBe(false)
  })
})

describe("verified sessions", () => {
  const until = new Date(now.getTime() + 3_600_000)
  it("hold for their link until they end", () => {
    const session = mintVerifiedSession("link_1", until, secret)
    expect(readVerifiedSession(session, "link_1", now, secret)).toBe(true)
    expect(readVerifiedSession(session, "link_1", until, secret)).toBe(false)
    // Verifying one link never verifies another.
    expect(readVerifiedSession(session, "link_2", now, secret)).toBe(false)
  })

  it("cannot be extended or forged", () => {
    const [id, , signature] = mintVerifiedSession("link_1", until, secret).split(".")
    expect(readVerifiedSession(`${id}.${until.getTime() + 86_400_000}.${signature}`, "link_1", now, secret)).toBe(false)
    expect(readVerifiedSession(`link_1.${until.getTime()}.forged`, "link_1", now, secret)).toBe(false)
    expect(readVerifiedSession(undefined, "link_1", now, secret)).toBe(false)
    expect(readVerifiedSession("garbage", "link_1", now, secret)).toBe(false)
  })

  it("use a cookie name that differs per link and reveals none of it", () => {
    expect(verifiedSessionCookieName("link_1")).not.toBe(verifiedSessionCookieName("link_2"))
    expect(verifiedSessionCookieName("link_1")).toMatch(/^qca_[0-9a-f]{16}$/)
  })
})

describe("verification codes", () => {
  it("match only the code and link they were made for", () => {
    const hash = hashVerificationCode("link_1", "123456", secret)
    expect(codesMatch(hash, "link_1", "123456", secret)).toBe(true)
    expect(codesMatch(hash, "link_1", "123457", secret)).toBe(false)
    expect(codesMatch(hash, "link_2", "123456", secret)).toBe(false)
    expect(hash).not.toContain("123456")
  })
})
