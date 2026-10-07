import { describe, expect, it } from "vitest"
import { resolveRecoveryClientKey } from "../auth/password-recovery"

const request = (chain: string) => new Request("http://localhost", { headers: { "x-forwarded-for": chain } })
describe("recovery trusted proxy chains", () => {
  it("uses only the actual peer without an allowlist", () => {
    expect(resolveRecoveryClientKey("127.0.0.1", request("198.51.100.2"))).toBe("127.0.0.1")
    expect(resolveRecoveryClientKey("198.51.100.3", request("198.51.100.2"), "127.0.0.1")).toBe("198.51.100.3")
  })
  it("walks right to left and stops at the first untrusted hop", () => {
    expect(resolveRecoveryClientKey("127.0.0.1", request("spoofed, 198.51.100.2, 10.1.2.3"), "127.0.0.1,10.0.0.0/8")).toBe("198.51.100.2")
    expect(resolveRecoveryClientKey("::ffff:127.0.0.1", request("2001:db8::2, ::1"), "127.0.0.1,::1/128")).toBe("2001:db8::2")
  })
  it("rejects malformed chains and uses a conservative key without a peer", () => {
    expect(resolveRecoveryClientKey("127.0.0.1", request("garbage"), "127.0.0.1")).toBe("127.0.0.1")
    expect(resolveRecoveryClientKey(undefined, request("198.51.100.2"), "127.0.0.1")).toBe("unknown-peer")
    expect(() => resolveRecoveryClientKey("127.0.0.1", request("198.51.100.2"), "10.0.0.0/33")).toThrow("QUITS_AUTH_TRUSTED_PROXIES")
  })
})
