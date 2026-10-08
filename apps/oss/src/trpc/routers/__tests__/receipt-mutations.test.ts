import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { fetchRequestHandler } from "@trpc/server/adapters/fetch"
import { TRPCError } from "@trpc/server"
import { Prisma } from "../../../../generated/prisma/client"
import { InvalidState, serializeDomainError } from "../../../domain/errors"
import { DomainRefusal } from "../../outcome"

const persistence = vi.hoisted(() => ({
  member: vi.fn(), transaction: vi.fn(), commandReceipt: vi.fn(), storeReceipt: vi.fn(),
  approval: vi.fn(), queryRaw: vi.fn(), executeRaw: vi.fn(), orgSettings: vi.fn(),
  contact: vi.fn(), receipt: vi.fn(),
}))
vi.mock("../../../lib/db", () => ({ prisma: {
  member: { findFirst: persistence.member }, $transaction: persistence.transaction,
  commandReceipt: { findUnique: persistence.commandReceipt, create: persistence.storeReceipt },
  approvalRequest: { findUnique: persistence.approval },
} }))

// HTTP serialization, real authorization and executor; only persistence is substituted.
let paymentsRouter: typeof import("../payments")["paymentsRouter"]
let createRequestContext: typeof import("../../init")["createRequestContext"]
beforeAll(async () => {
  vi.stubEnv("NODE_ENV", "production")
  ;({ paymentsRouter } = await import("../payments"))
  ;({ createRequestContext } = await import("../../init"))
})
afterAll(() => vi.unstubAllEnvs())
afterEach(() => vi.restoreAllMocks())
const tx = {
  $queryRaw: persistence.queryRaw, $executeRaw: persistence.executeRaw,
  orgSettings: { upsert: persistence.orgSettings, findUnique: persistence.orgSettings },
  commandReceipt: { findUnique: persistence.commandReceipt },
  contact: { findFirst: persistence.contact },
  settlementReceipt: { findFirst: persistence.receipt },
}
const evidence = { reason: "Reviewed statement", evidence: "https://example.test/statement" }
const cases = [
  { path: "recordReceipt", message: "Could not record receipt", input: {
    requestId: "record-request", contactId: "contact", currency: "DKK", netAmount: "40",
    feeAmount: "0", paidAt: "2026-01-15", method: "bank_transfer", reference: "statement-1", ...evidence,
  } },
  { path: "allocateReceipt", message: "Could not allocate receipt", input: {
    requestId: "allocate-request", receiptId: "receipt", allocations: [{ invoiceId: "invoice", receiptAmount: "40", invoiceAmount: "40" }], previewToken: "a".repeat(64), ...evidence,
  } },
  { path: "changeReceipt", message: "Could not change receipt", input: {
    requestId: "change-request", action: "refund", receiptId: "receipt", amount: "40", previewToken: "a".repeat(64), ...evidence,
  } },
] as const
const session = { user: { id: "operator", name: "Operator", email: "operator@example.test" }, session: { activeOrganizationId: "org" } }

async function http(path: string, input: unknown, signedIn = true) {
  const response = await fetchRequestHandler({ endpoint: "/api/trpc", router: paymentsRouter,
    req: new Request(`http://localhost/api/trpc/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ json: input }) }),
    createContext: () => createRequestContext(signedIn ? session as never : null, "org"),
  })
  const text = await response.text()
  return { status: response.status, text, body: JSON.parse(text) }
}
beforeEach(() => {
  vi.resetAllMocks()
  vi.spyOn(console, "error").mockImplementation(() => {})
  persistence.member.mockResolvedValue({ role: "admin" })
  persistence.commandReceipt.mockResolvedValue(null)
  persistence.storeReceipt.mockResolvedValue({})
  persistence.transaction.mockImplementation(async run => run(tx))
  persistence.queryRaw.mockResolvedValue([{ lockTimeout: "5s" }])
  persistence.executeRaw.mockResolvedValue(1)
  persistence.orgSettings.mockResolvedValue({})
  persistence.contact.mockResolvedValue(null)
  persistence.receipt.mockResolvedValue(null)
})

describe.each(cases)("$path production HTTP error boundary", ({ path, message, input }) => {
  it.each(["lock", "statement", "orm", "trpc", "lookalike"])("redacts unexpected %s errors without carrying a cause", async kind => {
    const marker = "SENSITIVE_INTERNAL_MARKER sql=private_table host=private-db password=synthetic"
    const error = kind === "lock" || kind === "statement"
      ? new Prisma.PrismaClientKnownRequestError(`${marker} canceling statement due to ${kind} timeout`, { code: "P2010", clientVersion: "7.4.2", meta: { code: kind === "lock" ? "55P03" : "57014" } })
      : kind === "orm" ? new Prisma.PrismaClientKnownRequestError(marker, { code: "P2024", clientVersion: "7.4.2" })
      : kind === "trpc" ? new TRPCError({ code: "FORBIDDEN", message: marker, cause: new DomainRefusal({ tag: "InvalidState", code: "private_code", message: marker, details: { host: "private-db" } }) })
      : { _tag: "InvalidState", code: "private_code", message: marker }
    persistence.transaction.mockRejectedValue(error)
    const response = await http(path, input)
    expect(response.status).toBe(500)
    expect(response.body.error.json).toMatchObject({ message, data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500, path, reason: null, details: null } })
    expect(response.body.error.json.data).not.toHaveProperty("stack")
    expect(response.text).not.toMatch(/SENSITIVE_INTERNAL_MARKER|private_table|private-db|synthetic|P2010|P2024|55P03|57014|Prisma|timeout|private_code/)
    const callerError = await paymentsRouter.createCaller(createRequestContext(session as never, "org"))[path](input as never).catch((failure: unknown) => failure)
    expect(callerError).toHaveProperty("cause", undefined)
  })

  it("preserves a real command-handler domain refusal", async () => {
    const response = await http(path, input)
    expect(response.status).toBe(path === "recordReceipt" ? 404 : 400)
    expect(response.body.error.json).toMatchObject({
      message: path === "recordReceipt" ? "Customer not found" : "Receipt not found",
      data: { code: path === "recordReceipt" ? "NOT_FOUND" : "BAD_REQUEST", reason: path === "recordReceipt" ? null : "receipt_not_found", details: null },
    })
    expect(persistence.transaction).toHaveBeenCalled()
  })

  it("preserves a trusted recorded refusal's reason and details", async () => {
    persistence.commandReceipt.mockResolvedValue({ id: "failed-command", status: "failed", result: null,
      error: serializeDomainError(new InvalidState({ code: "review_required", message: "Review the allocation", details: { available: "40.00", invoiceId: "invoice" } })),
    })
    const response = await http(path, input)
    expect(response.status).toBe(400)
    expect(response.body.error.json).toMatchObject({ message: "Review the allocation", data: { code: "BAD_REQUEST", reason: "review_required", details: { available: "40.00", invoiceId: "invoice" } } })
    expect(persistence.transaction).not.toHaveBeenCalled()
  })

  it("preserves awaiting-approval conflict", async () => {
    persistence.commandReceipt.mockResolvedValue({ id: "pending-command", status: "awaiting_approval", result: null, error: null })
    persistence.approval.mockResolvedValue({ id: "approval" })
    const response = await http(path, input)
    expect(response.status).toBe(409)
    expect(response.body.error.json).toMatchObject({ message: "This action is waiting for approval", data: { code: "CONFLICT" } })
  })

  it("rejects invalid evidence before executor persistence", async () => {
    const response = await http(path, { ...input, evidence: "https://user:credential@example.test/statement" })
    expect(response.status).toBe(400)
    expect(response.body.error.json.data.code).toBe("BAD_REQUEST")
    expect(persistence.commandReceipt).not.toHaveBeenCalled()
    expect(persistence.transaction).not.toHaveBeenCalled()
  })

  it.each(["anonymous", "nonmember", "accountant"])("preserves %s authorization refusal", async mode => {
    if (mode === "nonmember") persistence.member.mockResolvedValue(null)
    if (mode === "accountant") persistence.member.mockResolvedValue({ role: "accountant" })
    const response = await http(path, input, mode !== "anonymous")
    expect(response.status).toBe(mode === "anonymous" ? 401 : 403)
    expect(response.body.error.json.data.code).toBe(mode === "anonymous" ? "UNAUTHORIZED" : "FORBIDDEN")
    expect(persistence.commandReceipt).not.toHaveBeenCalled()
    expect(persistence.transaction).not.toHaveBeenCalled()
  })
})
