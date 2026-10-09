import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { fetchRequestHandler } from "@trpc/server/adapters/fetch"
import { TRPCError } from "@trpc/server"
import { Prisma } from "../../../../generated/prisma/client"
import { InvalidState, serializeDomainError } from "../../../domain/errors"
import { DomainRefusal } from "../../outcome"

const persistence = vi.hoisted(() => ({
  member: vi.fn(), transaction: vi.fn(), commandReceipt: vi.fn(), storeReceipt: vi.fn(),
  approval: vi.fn(), queryRaw: vi.fn(), executeRaw: vi.fn(), orgSettings: vi.fn(),
  contact: vi.fn(), evidence: vi.fn(),
}))
vi.mock("../../../lib/db", () => ({ prisma: {
  member: { findFirst: persistence.member }, $transaction: persistence.transaction,
  commandReceipt: { findUnique: persistence.commandReceipt, create: persistence.storeReceipt },
  approvalRequest: { findUnique: persistence.approval },
} }))

// Exercise real HTTP serialization, authorization, commands and preview. Only persistence is replaced.
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
  member: { findUnique: persistence.member },
  contact: { findFirst: persistence.contact },
  settlementEvidence: { findFirst: persistence.evidence },
}
const evidence = { reason: "Reviewed statement", evidence: "https://example.test/statement" }
const decision = {
  requestId: "decision-request", action: "unmatch" as const,
  evidenceId: "evidence", receiptId: "receipt", ...evidence,
}
const cases = [
  { path: "recordEvidence", method: "POST", message: "Could not record settlement evidence",
    refusal: "Customer not found", reason: "contact_not_found", input: {
      requestId: "record-request", contactId: "contact", source: "bank", state: "received",
      accountReference: "account", transactionReference: "transaction", eventReference: "event",
      occurredAt: "2026-01-15T12:00:00.000Z", currency: "DKK", netAmount: "40", feeAmount: "0", ...evidence,
    } },
  { path: "decideEvidence", method: "POST", message: "Could not decide settlement evidence",
    refusal: "Evidence not found", reason: "evidence_not_found",
    input: { decision, previewToken: "a".repeat(64) } },
  { path: "previewEvidenceDecision", method: "GET", message: "Could not preview evidence decision",
    refusal: "Evidence not found", reason: null, input: decision },
] as const
const mutations = cases.filter((entry) => entry.method === "POST")
const session = { user: { id: "operator", name: "Operator", email: "operator@example.test" }, session: { activeOrganizationId: "org" } }

async function http(testCase: typeof cases[number], input: unknown = testCase.input, signedIn = true) {
  const payload = JSON.stringify({ json: input })
  const url = new URL(`http://localhost/api/trpc/${testCase.path}`)
  if (testCase.method === "GET") url.searchParams.set("input", payload)
  const response = await fetchRequestHandler({ endpoint: "/api/trpc", router: paymentsRouter,
    req: new Request(url, { method: testCase.method, headers: { "content-type": "application/json" },
      ...(testCase.method === "POST" ? { body: payload } : {}),
    }),
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
  persistence.evidence.mockResolvedValue(null)
})

describe.each(cases)("$path production HTTP error boundary", (testCase) => {
  const { path, message, input, refusal, reason } = testCase
  it.each(["lock", "statement", "orm", "trpc", "lookalike", "string"])(
    "redacts unexpected %s errors without carrying a cause", async kind => {
      const marker = "SENSITIVE_INTERNAL_MARKER sql=private_table host=private-db password=synthetic"
      const error = kind === "lock" || kind === "statement"
        ? new Prisma.PrismaClientKnownRequestError(`${marker} canceling statement due to ${kind} timeout`, { code: "P2010", clientVersion: "7.4.2", meta: { code: kind === "lock" ? "55P03" : "57014" } })
        : kind === "orm" ? new Prisma.PrismaClientKnownRequestError(marker, { code: "P2024", clientVersion: "7.4.2" })
        : kind === "trpc" ? new TRPCError({ code: "FORBIDDEN", message: marker, cause: new DomainRefusal({ tag: "InvalidState", code: "private_code", message: marker, details: { host: "private-db" } }) })
        : kind === "string" ? marker : { _tag: "InvalidState", code: "private_code", message: marker }
      // Include failures after transaction entry as well as rejection by the transaction itself.
      if (kind === "orm" || kind === "string") persistence.orgSettings.mockRejectedValue(error)
      else persistence.transaction.mockRejectedValue(error)
      const response = await http(testCase)
      expect(response.status).toBe(500)
      expect(response.body.error.json).toMatchObject({ message, data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500, path, reason: null, details: null } })
      expect(response.body.error.json.data).not.toHaveProperty("stack")
      expect(response.text).not.toMatch(/SENSITIVE_INTERNAL_MARKER|private_table|private-db|synthetic|P2010|P2024|55P03|57014|Prisma|timeout|private_code/)
      const callerError = await paymentsRouter.createCaller(createRequestContext(session as never, "org"))[path](input as never).catch((failure: unknown) => failure)
      expect(callerError).toHaveProperty("cause", undefined)
    },
  )

  it("preserves a real domain refusal", async () => {
    const response = await http(testCase)
    expect(response.status).toBe(400)
    expect(response.body.error.json).toMatchObject({ message: refusal, data: { code: "BAD_REQUEST", reason, details: null } })
    expect(persistence.transaction).toHaveBeenCalled()
    expect(path === "recordEvidence" ? persistence.contact : persistence.evidence).toHaveBeenCalled()
  })

  it("rejects unsafe evidence before persistence", async () => {
    const unsafe = { evidence: "https://user:credential@example.test/statement" }
    const invalid = path === "decideEvidence"
      ? { ...input, decision: { ...decision, ...unsafe } }
      : { ...input, ...unsafe }
    const response = await http(testCase, invalid)
    expect(response.status).toBe(400)
    expect(response.body.error.json.data.code).toBe("BAD_REQUEST")
    expect(persistence.commandReceipt).not.toHaveBeenCalled()
    expect(persistence.transaction).not.toHaveBeenCalled()
  })

  it.each(["anonymous", "nonmember", "accountant"])("preserves %s authorization refusal", async mode => {
    if (mode === "nonmember") persistence.member.mockResolvedValue(null)
    if (mode === "accountant") persistence.member.mockResolvedValue({ role: "accountant" })
    const response = await http(testCase, input, mode !== "anonymous")
    expect(response.status).toBe(mode === "anonymous" ? 401 : 403)
    expect(response.body.error.json.data.code).toBe(mode === "anonymous" ? "UNAUTHORIZED" : "FORBIDDEN")
    expect(persistence.commandReceipt).not.toHaveBeenCalled()
    expect(persistence.transaction).not.toHaveBeenCalled()
  })
})

describe.each(mutations)("$path recorded command outcomes", (testCase) => {
  it("preserves a trusted recorded refusal's reason and details", async () => {
    persistence.commandReceipt.mockResolvedValue({ id: "failed-command", status: "failed", result: null,
      error: serializeDomainError(new InvalidState({ code: "review_required", message: "Review the evidence", details: { evidenceId: "evidence" } })),
    })
    const response = await http(testCase)
    expect(response.status).toBe(400)
    expect(response.body.error.json).toMatchObject({ message: "Review the evidence", data: { code: "BAD_REQUEST", reason: "review_required", details: { evidenceId: "evidence" } } })
    expect(persistence.transaction).not.toHaveBeenCalled()
  })

  it("preserves awaiting-approval conflict", async () => {
    persistence.commandReceipt.mockResolvedValue({ id: "pending-command", status: "awaiting_approval", result: null, error: null })
    persistence.approval.mockResolvedValue({ id: "approval" })
    const response = await http(testCase)
    expect(response.status).toBe(409)
    expect(response.body.error.json).toMatchObject({ message: "This action is waiting for approval", data: { code: "CONFLICT" } })
  })
})

it("requires payment:void for an unmatch preview before accessing persistence", async () => {
  persistence.member.mockResolvedValue({ role: "member" })
  const response = await http(cases[2])
  expect(response.status).toBe(403)
  expect(response.body.error.json.message).toBe("Missing permission payment:void")
  expect(persistence.transaction).not.toHaveBeenCalled()
})
