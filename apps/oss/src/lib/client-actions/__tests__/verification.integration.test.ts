import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createTestOrganization, hasTestDatabase } from "../../../test-utils/organization"
import { prisma } from "../../db"
import { resolveClientActionAccess } from "../access"
import { mintClientActionToken } from "../tokens"
import { checkVerificationCode, requestVerificationCode } from "../verification"

const cleanups: Array<() => Promise<void>> = []
const now = new Date()
const context = { sellerName: "Test seller", locale: "en-US" }

beforeEach(() => vi.stubEnv("QUITS_PUBLIC_CLIENT_ACTION_SECRET", "client-verification-test-secret"))
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.()
  vi.unstubAllEnvs()
})

async function setup() {
  const org = await createTestOrganization()
  cleanups.push(org.cleanup)
  const contact = await prisma.contact.create({ data: { organizationId: org.organizationId, name: "Recipient" } })
  const row = await prisma.clientActionLink.create({ data: {
    organizationId: org.organizationId, contactId: contact.id, recipientName: "Recipient",
    recipientEmail: "recipient@example.test", verification: "email_code",
    expiresAt: new Date(now.getTime() + 86_400_000), createdBy: org.actors.admin.userId,
  } })
  const access = await resolveClientActionAccess(mintClientActionToken(row.id), now)
  if (access.status !== "active") throw new Error("Expected an active test link")
  const codes: string[] = []
  const send = vi.fn(async ({ code }: { code: string }) => { codes.push(code); return { id: "captured-test-message" } })
  const request = (at = now) => requestVerificationCode(access.link, context, at, send)
  return { link: access.link, codes, send, request }
}

describe.runIf(hasTestDatabase)("client verification challenge concurrency", () => {
  it("never revives A after requesting B and consuming B", async () => {
    const { link, codes, request } = await setup()
    await request()
    await request(new Date(now.getTime() + 1000))
    const at = new Date(now.getTime() + 2000)
    expect(await checkVerificationCode(link, codes[1]!, at)).toBe("verified")
    expect(await checkVerificationCode(link, codes[0]!, at)).toBe("expired")
    expect(await prisma.clientActionVerification.count({ where: { linkId: link.id, consumedAt: null } })).toBe(0)
  })

  it("reserves at most five rows and sends across twenty real concurrent database requests", async () => {
    const { link, send, request } = await setup()
    const outcomes = await Promise.all(Array.from({ length: 20 }, () => request()))
    expect(outcomes.filter((outcome) => outcome === "sent")).toHaveLength(5)
    expect(outcomes.filter((outcome) => outcome === "rate_limited")).toHaveLength(15)
    expect(send).toHaveBeenCalledTimes(5)
    expect(await prisma.clientActionVerification.count({ where: { linkId: link.id } })).toBe(5)
    expect(await prisma.clientActionVerification.count({ where: { linkId: link.id, consumedAt: null } })).toBe(1)
  })

  it("retires older challenges even when the creation timestamps tie", async () => {
    const { link, codes, request } = await setup()
    await request()
    await request()
    // Same transaction timestamps must not make the older row current again.
    await prisma.clientActionVerification.updateMany({ where: { linkId: link.id }, data: { createdAt: now } })
    expect(await checkVerificationCode(link, codes[1]!, now)).toBe("verified")
    expect(await checkVerificationCode(link, codes[0]!, now)).toBe("expired")
  })

  it("does not revive A after B fails to send, and refunds only B's reservation", async () => {
    const { link, codes, send, request } = await setup()
    await request()
    send.mockRejectedValueOnce(new Error("synthetic sender failure"))
    expect(await request()).toBe("unavailable")
    expect(await checkVerificationCode(link, codes[0]!, now)).toBe("expired")
    expect(await prisma.clientActionVerification.count({ where: { linkId: link.id } })).toBe(1)
    for (let i = 0; i < 4; i++) expect(await request()).toBe("sent")
    expect(await request()).toBe("rate_limited")
  })

  it("keeps C current when an earlier in-flight B send fails", async () => {
    const { link, codes, request } = await setup()
    await request()
    let failSend!: (reason: Error) => void
    let sending!: () => void
    const started = new Promise<void>((resolve) => { sending = resolve })
    const pending = requestVerificationCode(link, context, now, () => {
      sending()
      return new Promise<{ id: string }>((_resolve, reject) => { failSend = reject })
    })
    await started
    try {
      expect(await request()).toBe("sent")
    } finally {
      failSend(new Error("B failed after C was sent"))
      expect(await pending).toBe("unavailable")
    }
    expect(await checkVerificationCode(link, codes[1]!, now)).toBe("verified")
    expect(await checkVerificationCode(link, codes[0]!, now)).toBe("expired")
  })

  it("accepts the current code once across concurrent checks", async () => {
    const { link, codes, request } = await setup()
    await request()
    const outcomes = await Promise.all(Array.from({ length: 20 }, () => checkVerificationCode(link, codes[0]!, now)))
    expect(outcomes.filter((outcome) => outcome === "verified")).toHaveLength(1)
    expect(await checkVerificationCode(link, codes[0]!, now)).toBe("expired")
  })

  it("refuses a purged recovery challenge while retaining the explicitly granted link", async () => {
    const { link, codes, request } = await setup()
    await request()
    await prisma.clientActionVerification.deleteMany({ where: { linkId: link.id } })
    expect(await checkVerificationCode(link, codes[0]!, now)).toBe("expired")
    expect((await resolveClientActionAccess(mintClientActionToken(link.id), now)).status).toBe("active")
    expect(await request()).toBe("sent")
    expect(await checkVerificationCode(link, codes[1]!, now)).toBe("verified")
  })

  it("counts at most five concurrent guesses and never falls back after lockout or expiry", async () => {
    const { link, codes, request } = await setup()
    await request()
    await request()
    const wrong = codes.includes("000000") ? "abcdef" : "000000"
    const outcomes = await Promise.all(Array.from({ length: 20 }, () => checkVerificationCode(link, wrong, now)))
    expect(outcomes.filter((outcome) => outcome === "wrong")).toHaveLength(5)
    expect(await checkVerificationCode(link, codes[0]!, now)).toBe("locked")
    expect(await checkVerificationCode(link, codes[1]!, new Date(now.getTime() + 600_001))).toBe("expired")
    const rows = await prisma.clientActionVerification.findMany({ where: { linkId: link.id } })
    expect(rows.map((row) => row.attempts).sort()).toEqual([0, 5])
  })
})
