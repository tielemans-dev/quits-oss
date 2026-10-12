import { Effect, Either } from "effect"
import type { Prisma } from "../../../../generated/prisma/client"
import { Db, Command } from "../../../domain/services"
import { recordAgreementCustomerDecision } from "../../../domain/commands/agreement-lifecycle"
import { beforeEach, describe, expect, it, vi } from "vitest"
vi.mock("../../auth", () => ({ auth: { api: { getSession: vi.fn() } } }))
vi.mock("../../db", () => ({ prisma: { agreement: { findUnique: vi.fn() } } }))
vi.mock("../../documents/pdf-access", () => ({ storedPdfResponse: vi.fn() }))
import { publicAgreementPdf } from "../pdf-access"
import { decidePublicAgreementByToken, decidePublicDeliverableByToken } from "../public-access"
import { prisma } from "../../db"
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
