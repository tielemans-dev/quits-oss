import { Effect, Either } from "effect"
import type { AnyCommandDefinition } from "../../../domain/command"
import type { Actor } from "../../../domain/actor"
import type { Prisma } from "../../../../generated/prisma/client"
import { Db, Command } from "../../../domain/services"
import { recordAgreementCustomerDecision } from "../../../domain/commands/agreement-lifecycle"
import { beforeEach, describe, expect, it, vi } from "vitest"
vi.mock("../../auth", () => ({ auth: { api: { getSession: vi.fn() } } }))
vi.mock("../../db", () => ({ prisma: { agreement: { findUnique: vi.fn() } } }))
const harness = vi.hoisted(() => ({ db: {} as unknown, errors: [] as unknown[] }))
vi.mock("../../public-links/rate-limit", () => ({ recordPublicLinkAttempt: vi.fn() }))
// Keep the real command handler, locks and token validity checks; replace only command persistence.
vi.mock("../../../domain/execute", () => ({ executeCommand: vi.fn(async (command: AnyCommandDefinition, input: unknown, options: { actor: Actor; now: Date }) => {
  const result = await Effect.runPromise(command.handle(input).pipe(
    Effect.provideService(Db, harness.db as Prisma.TransactionClient),
    Effect.provideService(Command, { ...options, organizationId: options.actor.organizationId, emit: vi.fn(), enqueue: vi.fn() } as never),
    Effect.either,
  ))
  if (Either.isLeft(result)) {
    harness.errors.push(result.left)
    return { status: "failed", error: result.left }
  }
  return { status: "completed", result: result.right }
}) }))
vi.mock("../../documents/pdf-access", () => ({ storedPdfResponse: vi.fn() }))
import { publicAgreementPdf } from "../pdf-access"
import { decidePublicAgreementByToken, decidePublicDeliverableByToken } from "../public-access"
import { prisma } from "../../db"
import { getAgreementPublicSecret, signAgreementPublicToken } from "../tokens"
import { storedPdfResponse } from "../../documents/pdf-access"
beforeEach(() => { vi.stubEnv("BETTER_AUTH_SECRET", "synthetic-public-link-secret-over-32-characters"); vi.clearAllMocks() })
describe("raw invalid agreement links", () => {
  it.each([["da-DK", "Dette link er ikke længere gyldigt"], ["en-US", "This link is no longer valid"]])("localizes PDF and decision failures in %s without loading a document", async (locale, message) => {
    const response = await publicAgreementPdf("invalid-token", locale)
    expect(response.status).toBe(404)
    expect(await response.text()).toBe(message)
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    await expect(decidePublicAgreementByToken("invalid-token", {}, {}, new Date(), locale)).rejects.toMatchObject({ code: "invalid", message })
    await expect(decidePublicDeliverableByToken("invalid-token", {}, new Date(), locale)).rejects.toMatchObject({ code: "invalid", message })
    expect(prisma.agreement.findUnique).not.toHaveBeenCalled()
  })
  it("localizes the domain invalid-link failure using organization language", async () => {
    const settings = vi.fn().mockResolvedValue({ locale: "da-DK" })
    const result = await Effect.runPromise(recordAgreementCustomerDecision.handle({ token: "invalid-token", decision: { decision: "decline" } }).pipe(
      Effect.provideService(Db, { orgSettings: { findUnique: settings } } as unknown as Prisma.TransactionClient),
      Effect.provideService(Command, { actor: { kind: "system", reason: "customer_link" }, organizationId: "synthetic-org" } as never),
      Effect.either,
    ))
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) expect(result.left).toMatchObject({ code: "invalid", message: "Dette link er ikke længere gyldigt" })
    expect(settings).toHaveBeenCalledWith({ where: { organizationId: "synthetic-org" }, select: { locale: true } })
  })
})

describe("authenticated stale public links", () => {
  it.each(["da-DK", "en-US"])("localizes real stale offer decisions and PDF failures in %s", async locale => {
    const now = new Date("2030-01-01")
    const message = locale === "da-DK" ? "Dette link er ikke længere gyldigt" : "This link is no longer valid"
    for (const stale of ["revoked", "revision", "expired"] as const) {
      const agreement = {
        id: "agreement", organizationId: "org", status: "sent", locale,
        publicAccessKeyVersion: stale === "revoked" ? 2 : 1,
        offerRevision: stale === "revision" ? 2 : 1, offerSnapshot: {},
        expiresAt: new Date("2099-01-01"), deliverables: [],
        acceptedOfferRevision: null, acceptedAt: null, declinedAt: null, lastEmailAttemptOutcome: null,
      }
      const db = {
        $queryRaw: vi.fn().mockResolvedValue([]),
        agreement: { findFirst: vi.fn().mockResolvedValue(agreement), update: vi.fn() },
        orgSettings: { findUnique: vi.fn().mockResolvedValue({ locale }) },
      }
      harness.db = db
      harness.errors = []
      vi.mocked(prisma.agreement.findUnique).mockResolvedValue(agreement as never)
      const token = signAgreementPublicToken({ agreementId: "agreement", keyVersion: 1, scope: "decide", offerRevision: 1, exp: stale === "expired" ? "2000-01-01T00:00:00.000Z" : "2099-01-01T00:00:00.000Z" }, getAgreementPublicSecret())
      await expect(decidePublicAgreementByToken(token, { decision: "decline" }, {}, now, locale)).rejects.toMatchObject({ code: "invalid", message })
      expect(harness.errors).toHaveLength(1)
      expect(harness.errors[0]).toMatchObject({ code: "invalid", message })
      expect(db.agreement.update).not.toHaveBeenCalled()
      const response = await publicAgreementPdf(token, locale)
      expect(response.status).toBe(404)
      expect(await response.text()).toBe(message)
      expect(storedPdfResponse).not.toHaveBeenCalled()
    }
  })

  it.each(["da-DK", "en-US"])("localizes real stale sign-off failures in %s", async locale => {
    const now = new Date("2030-01-01")
    const message = locale === "da-DK" ? "Dette link er ikke længere gyldigt" : "This link is no longer valid"
    for (const stale of ["revoked", "revision", "expired"] as const) {
      const agreement = {
        id: "agreement", organizationId: "org", status: "accepted", locale,
        publicAccessKeyVersion: stale === "revoked" ? 2 : 1, offerSnapshot: {},
        deliverables: [{ id: "line", deliveryRevision: stale === "revision" ? 2 : 1, status: "delivered", isDeposit: false }],
      }
      const db = {
        $queryRaw: vi.fn().mockResolvedValue([]), agreement: { findFirst: vi.fn().mockResolvedValue(agreement) },
        deliverable: { update: vi.fn() }, orgSettings: { findUnique: vi.fn().mockResolvedValue({ locale }) },
      }
      harness.db = db
      harness.errors = []
      vi.mocked(prisma.agreement.findUnique).mockResolvedValue(agreement as never)
      const token = signAgreementPublicToken({ agreementId: "agreement", keyVersion: 1, scope: "sign_off", deliverableId: "line", deliveryRevision: 1, exp: stale === "expired" ? "2000-01-01T00:00:00.000Z" : "2099-01-01T00:00:00.000Z" }, getAgreementPublicSecret())
      for (const decision of [{ decision: "accept", confirmed: true }, { decision: "request_changes", note: "Please revise" }]) {
        await expect(decidePublicDeliverableByToken(token, decision, now, locale)).rejects.toMatchObject({ code: "invalid", message })
      }
      expect(harness.errors).toHaveLength(2)
      // The internal command contract stays unchanged; localization happens at public presentation.
      expect(harness.errors[0]).toMatchObject({ code: "invalid", message: "This link is no longer valid" })
      expect(db.$queryRaw).toHaveBeenCalledTimes(2)
      expect(db.deliverable.update).not.toHaveBeenCalled()
      const response = await publicAgreementPdf(token, locale)
      expect(response.status).toBe(404)
      expect(await response.text()).toBe(message)
      expect(response.headers.get("cache-control")).toBe("private, no-store")
      expect(response.headers.get("vary")).toBe("Accept-Language")
      expect(storedPdfResponse).not.toHaveBeenCalled()
    }
  })
})
