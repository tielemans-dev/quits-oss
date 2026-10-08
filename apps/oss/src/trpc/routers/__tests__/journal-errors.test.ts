import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { fetchRequestHandler } from "@trpc/server/adapters/fetch"
import { TRPCError } from "@trpc/server"
import { Prisma } from "../../../../generated/prisma/client"
import { InvalidState, serializeDomainError } from "../../../domain/errors"
import { DomainRefusal } from "../../outcome"

const persistence = vi.hoisted(() => ({
  member: vi.fn(), transaction: vi.fn(), commandReceipt: vi.fn(), storeReceipt: vi.fn(),
  approval: vi.fn(), queryRaw: vi.fn(), executeRaw: vi.fn(), orgSettings: vi.fn(), invoice: vi.fn(), job: vi.fn(),
}))
vi.mock("../../../lib/db", () => ({ prisma: {
  member: { findFirst: persistence.member }, $transaction: persistence.transaction,
  commandReceipt: { findUnique: persistence.commandReceipt, create: persistence.storeReceipt },
  approvalRequest: { findUnique: persistence.approval }, invoice: { findFirst: persistence.invoice },
} }))

// Real router, authorization, services, executor and production HTTP serialization; fake persistence.
let journalRouter: typeof import("../journal")["journalRouter"]
let createRequestContext: typeof import("../../init")["createRequestContext"]
beforeAll(async () => {
  vi.stubEnv("NODE_ENV", "production")
  ;({ journalRouter } = await import("../journal"))
  ;({ createRequestContext } = await import("../../init"))
})
afterAll(() => vi.unstubAllEnvs())
const tx = {
  $queryRaw: persistence.queryRaw, $executeRaw: persistence.executeRaw,
  orgSettings: { upsert: persistence.orgSettings },
  commandReceipt: { findUnique: persistence.commandReceipt }, invoice: { findFirst: persistence.invoice }, job: { findFirst: persistence.job },
}
const input = {
  documentType: "invoice", documentId: "invoice", deliveryId: "source", mode: "stored",
  reviewedTarget: { revision: "reviewed", recipient: "buyer@example.test", publicLinkKeyVersion: "1" },
  reason: "Reviewed uncertain delivery", acknowledgeDuplicateRisk: true, clientRequestId: "manual-request",
} as const
const session = { user: { id: "operator", name: "Operator", email: "operator@example.test" }, session: { activeOrganizationId: "org" } }
const routes = [
  { path: "forDocument", message: "Could not load operation history" },
  { path: "recover", message: "Could not recover delivery" },
  { path: "reconcile", message: "Could not reconcile delivery" },
  { path: "manualResend", message: "Could not resend document" },
] as const
async function http(path: string, signedIn = true, organization = "org") {
  const serialized = JSON.stringify({ json: input })
  const query = path === "forDocument"
  const response = await fetchRequestHandler({ endpoint: "/api/trpc", router: journalRouter,
    req: new Request(`http://localhost/api/trpc/${path}${query ? `?input=${encodeURIComponent(serialized)}` : ""}`, query ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: serialized }),
    createContext: () => createRequestContext(signedIn ? session as never : null, organization),
  })
  const text = await response.text()
  return { status: response.status, text, body: JSON.parse(text) }
}
beforeEach(() => {
  vi.resetAllMocks()
  persistence.member.mockResolvedValue({ role: "admin" })
  persistence.commandReceipt.mockResolvedValue(null)
  persistence.storeReceipt.mockResolvedValue({})
  persistence.transaction.mockImplementation(async run => run(tx))
  persistence.queryRaw.mockResolvedValue([{ lockTimeout: "5s" }])
  persistence.executeRaw.mockResolvedValue(1)
  persistence.orgSettings.mockResolvedValue({})
  persistence.invoice.mockResolvedValue(null)
})

describe.each(routes)("$path production HTTP errors", ({ path, message }) => {
  it.each(["lock", "statement", "orm", "trpc", "lookalike"])("redacts unexpected %s failures without a public cause", async kind => {
    const marker = "PRIVATE_JOURNAL_MARKER table=private_delivery host=private-db"
    const error = kind === "lock" || kind === "statement"
      ? new Prisma.PrismaClientKnownRequestError(`${marker} ${kind} timeout`, { code: "P2010", clientVersion: "7.4.2", meta: { code: kind === "lock" ? "55P03" : "57014" } })
      : kind === "orm" ? new Prisma.PrismaClientKnownRequestError(marker, { code: "P2024", clientVersion: "7.4.2" })
      : kind === "trpc" ? new TRPCError({ code: "FORBIDDEN", message: marker, cause: new DomainRefusal({ tag: "InvalidState", code: "private_code", message: marker, details: { host: "private-db" } }) })
      : { _tag: "InvalidState", code: "private_code", message: marker }
    persistence.transaction.mockRejectedValue(error)
    persistence.invoice.mockRejectedValue(error)
    const response = await http(path)
    expect(response.status).toBe(500)
    expect(response.body.error.json).toMatchObject({ message, data: { code: "INTERNAL_SERVER_ERROR", reason: null, details: null } })
    expect(response.body.error.json.data).not.toHaveProperty("stack")
    expect(response.text).not.toMatch(/PRIVATE_JOURNAL_MARKER|private_delivery|private-db|P2010|P2024|55P03|57014|private_code/)
    const failure = await journalRouter.createCaller(createRequestContext(session as never, "org"))[path](input).catch((error: unknown) => error)
    expect(failure).toHaveProperty("cause", undefined)
    expect(persistence.storeReceipt).not.toHaveBeenCalled()
  })

  it("preserves an actual service or command-handler NotFound", async () => {
    const response = await http(path)
    expect(response.status).toBe(404)
    expect(response.body.error.json).toMatchObject({ message: "Document not found", data: { code: "NOT_FOUND" } })
  })

  it.each(["anonymous", "nonmember"])("preserves %s refusal before persistence", async mode => {
    if (mode === "nonmember") persistence.member.mockResolvedValue(null)
    const response = await http(path, mode !== "anonymous")
    expect(response.status).toBe(mode === "anonymous" ? 401 : 403)
    expect(persistence.transaction).not.toHaveBeenCalled()
    expect(persistence.invoice).not.toHaveBeenCalled()
  })

  it("rejects organization mismatch before membership lookup", async () => {
    expect((await http(path, true, "other-org")).status).toBe(409)
    expect(persistence.member).not.toHaveBeenCalled()
    expect(persistence.transaction).not.toHaveBeenCalled()
  })
})

it("preserves trusted recorded refusal reason/details and awaiting approval", async () => {
  persistence.commandReceipt.mockResolvedValue({ id: "failed", status: "failed", result: null,
    error: serializeDomainError(new InvalidState({ code: "review_required", message: "Review delivery", details: { deliveryId: "source" } })),
  })
  let response = await http("manualResend")
  expect(response.status).toBe(400)
  expect(response.body.error.json).toMatchObject({ message: "Review delivery", data: { reason: "review_required", details: { deliveryId: "source" } } })
  persistence.commandReceipt.mockResolvedValue({ id: "pending", status: "awaiting_approval", result: null, error: null })
  persistence.approval.mockResolvedValue({ id: "approval" })
  response = await http("manualResend")
  expect(response.status).toBe(409)
  expect(response.body.error.json.message).toBe("This action is waiting for approval")
  expect(persistence.transaction).not.toHaveBeenCalled()
})

it("redacts projection failures after a trusted completed command", async () => {
  persistence.commandReceipt.mockResolvedValue({ id: "completed", status: "completed", result: {}, error: null })
  persistence.invoice.mockRejectedValue(new Error("PRIVATE_JOURNAL_MARKER"))
  const response = await http("manualResend")
  expect(response.status).toBe(500)
  expect(response.body.error.json.message).toBe("Could not load operation history")
  expect(response.text).not.toContain("PRIVATE_JOURNAL_MARKER")
  expect(persistence.transaction).not.toHaveBeenCalled()
})

it.each(["recover", "reconcile", "manualResend"] as const)("%s rechecks membership after a cached journal query", async path => {
  const context = createRequestContext(session as never, "org")
  const caller = journalRouter.createCaller(context)
  await expect(caller.forDocument(input)).rejects.toMatchObject({ code: "NOT_FOUND" })
  await expect(caller.forDocument(input)).rejects.toMatchObject({ code: "NOT_FOUND" })
  expect(persistence.member).toHaveBeenCalledTimes(1)
  persistence.member.mockResolvedValue(null)
  persistence.transaction.mockClear()
  await expect(caller[path](input)).rejects.toMatchObject({ code: "FORBIDDEN" })
  expect(persistence.member).toHaveBeenCalledTimes(2)
  expect(persistence.transaction).not.toHaveBeenCalled()
})

it.each(["recover", "reconcile", "manualResend"] as const)("%s preserves accountant send refusal", async path => {
  persistence.member.mockResolvedValue({ role: "accountant" })
  const response = await http(path)
  expect(response.status).toBe(403)
  expect(response.body.error.json.data.code).toBe("FORBIDDEN")
  expect(persistence.invoice).not.toHaveBeenCalled()
})

it.each(["forDocument", "recover", "reconcile"] as const)("%s retains expected typed service refusal reason/details", async path => {
  persistence.invoice.mockRejectedValue(new InvalidState({ code: "unsafe_retry", message: "Verify delivery first", details: { deliveryId: "source" } }))
  const response = await http(path)
  expect(response.status).toBe(412)
  expect(response.body.error.json).toMatchObject({ message: "Verify delivery first", data: { reason: "unsafe_retry", details: { deliveryId: "source" } } })
})

it("does not mistake a rejected executor promise for a returned domain refusal", async () => {
  persistence.transaction.mockRejectedValue(new InvalidState({ code: "private_code", message: "PRIVATE_JOURNAL_MARKER" }))
  const response = await http("manualResend")
  expect(response.status).toBe(500)
  expect(response.body.error.json).toMatchObject({ message: "Could not resend document", data: { reason: null, details: null } })
  expect(response.text).not.toContain("PRIVATE_JOURNAL_MARKER")
})


it.each(["document", "reviewed document", "delivery"] as const)("does not persist unexpected failures while reading %s inside the resend handler", async stage => {
  const failure = new Prisma.PrismaClientKnownRequestError("PRIVATE_JOURNAL_MARKER", { code: "P2010", clientVersion: "7.4.2", meta: { code: "55P03" } })
  persistence.invoice.mockResolvedValue({ id: "invoice", contactId: "contact" })
  if (stage === "document") persistence.invoice.mockResolvedValueOnce({ agreementId: null }).mockRejectedValueOnce(failure)
  if (stage === "reviewed document") persistence.invoice.mockResolvedValueOnce({ agreementId: null }).mockResolvedValueOnce({ id: "invoice", contactId: "contact" }).mockRejectedValueOnce(failure)
  if (stage === "delivery") persistence.job.mockRejectedValue(failure)
  const response = await http("manualResend")
  expect(response.status).toBe(500)
  expect(response.body.error.json).toMatchObject({ message: "Could not resend document", data: { reason: null, details: null } })
  expect(response.text).not.toContain("PRIVATE_JOURNAL_MARKER")
  expect(persistence.storeReceipt).not.toHaveBeenCalled()
})
