import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fetchRequestHandler } from "@trpc/server/adapters/fetch"
import superjson from "superjson"
import { appLogger } from "../../../lib/observability"
import {
  ManagedDomainRejectedError,
  isManagedDomainRejection,
  resetRuntimeServices,
  setRuntimeServices,
} from "@quits/oss/runtime/services"
import { settingsRouter } from "../settings"

const db = vi.hoisted(() => ({ upsert: vi.fn(), update: vi.fn() }))
vi.mock("../../../lib/db", () => ({ prisma: { orgSettings: db } }))
vi.mock("../../../domain/user-actor", () => ({
  resolveUserActor: async () => ({
    kind: "user", organizationId: "org", userId: "user", roles: ["admin"], label: "Test",
  }),
}))

const provider = {
  supported: true,
  createDomain: vi.fn(),
  refreshDomain: vi.fn(),
  deleteDomain: vi.fn(),
}
const stored = {
  locale: "en-US",
  documentSendingDomain: "billing.example.com",
  documentSendingDomainProviderId: "domain-1",
  documentSendingDomainStatus: "verified",
}
const operations = [
  { path: "configureDocumentSendingDomain", method: "createDomain", input: { domain: "billing.example.com" } },
  { path: "configureDocumentSendingDomain", method: "deleteDomain", input: { domain: "new.example.com" } },
  { path: "refreshDocumentSendingDomain", method: "refreshDomain", input: undefined },
  { path: "disableDocumentSendingDomain", method: "deleteDomain", input: undefined },
] as const
const rejections = [
  { reason: "invalid_domain", code: "BAD_REQUEST", status: 400,
    en: "The sending domain was rejected. Check the domain and try again.",
    da: "Afsenderdomænet blev afvist. Kontrollér domænet, og prøv igen." },
  { reason: "not_found", code: "NOT_FOUND", status: 404,
    en: "The sending domain could not be found. Check the domain setup and try again.",
    da: "Afsenderdomænet blev ikke fundet. Kontrollér domæneopsætningen, og prøv igen." },
  { reason: "conflict", code: "CONFLICT", status: 409,
    en: "The sending domain conflicts with an existing setup. Check the domain setup and try again.",
    da: "Afsenderdomænet er i konflikt med en eksisterende opsætning. Kontrollér domæneopsætningen, og prøv igen." },
] as const

async function request(operation: typeof operations[number]) {
  return fetchRequestHandler({
    endpoint: "/trpc",
    req: new Request(`http://localhost/trpc/${operation.path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: superjson.stringify(operation.input),
    }),
    router: settingsRouter,
    createContext: async () => ({
      session: {
        user: { id: "user", email: "test@example.com", name: "Test" },
        session: { activeOrganizationId: "org" },
      },
    } as never),
  })
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.spyOn(appLogger, "warn").mockImplementation(() => {})
  db.upsert.mockResolvedValue({ ...stored })
  db.update.mockImplementation(async ({ data }) => ({ ...stored, ...data }))
  const result = {
    providerId: "domain-1", domain: "billing.example.com", status: "verified",
    records: [], failureReason: null, verifiedAt: new Date(),
  }
  provider.createDomain.mockImplementation(async ({ domain }) => ({ ...result, domain }))
  provider.refreshDomain.mockResolvedValue(result)
  setRuntimeServices({ managedDocumentDomainProvider: provider })
})
afterEach(() => { resetRuntimeServices(); vi.restoreAllMocks() })

describe.each(operations)("$path via $method", (operation) => {
  it.each(rejections.filter(rejection => operation.method !== "deleteDomain" || rejection.reason !== "not_found")
    .flatMap(rejection => ["en", "da"].map(language => ({
    ...rejection, language, locale: language === "da" ? "da-DK" : "en-US",
    message: language === "da" ? rejection.da : rejection.en,
  }))))("returns a safe localized $status for $reason in $language", async (rejection) => {
    db.upsert.mockResolvedValue({ ...stored, locale: rejection.locale })
    const error = new ManagedDomainRejectedError(rejection.reason)
    // Even an adapter attaching private diagnostics must not expose them to the client.
    error.message = "private provider response"
    error.cause = new Error("private provider diagnostics")
    provider[operation.method].mockRejectedValue(error)

    const response = await request(operation)
    const body = await response.json()
    expect(response.status, JSON.stringify(body)).toBe(rejection.status)
    expect(body.error.json).toMatchObject({
      message: rejection.message,
      data: { code: rejection.code, httpStatus: rejection.status },
    })
    expect(JSON.stringify(body)).not.toContain("private provider")
    expect(provider[operation.method]).toHaveBeenCalledOnce()
    expect(db.update).not.toHaveBeenCalled()
    expect(appLogger.warn).toHaveBeenCalledExactlyOnceWith("settings.managed_domain_rejected", {
      organizationId: "org", operation: operation.method, reason: rejection.reason,
    })
    if (operation.method === "deleteDomain") expect(provider.createDomain).not.toHaveBeenCalled()
  })

  it("keeps unexpected provider failures as 500 errors", async () => {
    provider[operation.method].mockRejectedValue(new Error("Unexpected failure"))
    const response = await request(operation)
    expect(response.status).toBe(500)
    expect((await response.json()).error.json.data.code).toBe("INTERNAL_SERVER_ERROR")
    expect(provider[operation.method]).toHaveBeenCalledOnce()
    expect(db.update).not.toHaveBeenCalled()
  })

  it("recognizes a branded rejection from another package copy", async () => {
    const error = { code: "MANAGED_DOMAIN_REJECTED", reason: "conflict", message: "private provider response" }
    expect(error).not.toBeInstanceOf(ManagedDomainRejectedError)
    expect(isManagedDomainRejection(error)).toBe(true)
    provider[operation.method].mockRejectedValue(error)
    const response = await request(operation)
    expect(response.status).toBe(409)
    expect(JSON.stringify(await response.json())).not.toContain("private provider")
    expect(provider[operation.method]).toHaveBeenCalledOnce()
    expect(db.update).not.toHaveBeenCalled()
  })

  it("preserves a branded rejection with an unknown reason as a plain 500", async () => {
    const error = Object.assign(new ManagedDomainRejectedError("conflict"), {
      reason: "future_reason",
    })
    expect(isManagedDomainRejection(error)).toBe(false)
    provider[operation.method].mockRejectedValue(error)
    const response = await request(operation)
    expect(response.status).toBe(500)
    expect((await response.json()).error.json).toMatchObject({
      message: "Managed domain request rejected", data: { code: "INTERNAL_SERVER_ERROR" },
    })
    expect(provider[operation.method]).toHaveBeenCalledOnce()
    expect(db.update).not.toHaveBeenCalled()
    expect(appLogger.warn).not.toHaveBeenCalled()
  })

  it("allows retry after a rejection without changing settings on failure", async () => {
    provider[operation.method].mockRejectedValueOnce(new ManagedDomainRejectedError("conflict"))
    expect((await request(operation)).status).toBe(409)
    expect(db.update).not.toHaveBeenCalled()
    const response = await request(operation)
    expect(response.status).toBe(200)
    expect(db.update).toHaveBeenCalledOnce()
    expect((await response.json()).result.data.json.status).toBe(
      operation.path === "disableDocumentSendingDomain" ? "not_configured" : "verified",
    )
  })
})

it.each(["configure", "disable"])("recovers via %s after deleting the old domain and rejecting its replacement", async action => {
  provider.deleteDomain.mockResolvedValueOnce(undefined).mockRejectedValue(new ManagedDomainRejectedError("not_found"))
  provider.createDomain.mockRejectedValueOnce(new ManagedDomainRejectedError("invalid_domain"))
  const configure = operations[1]
  expect((await request(configure)).status).toBe(400)
  expect(provider.deleteDomain).toHaveBeenCalledOnce()
  expect(provider.createDomain).toHaveBeenCalledOnce()
  expect(db.update).not.toHaveBeenCalled()

  const response = await request(action === "configure" ? configure : operations[3])
  expect(response.status).toBe(200)
  expect((await response.json()).result.data.json.requestedDomain).toBe(action === "configure" ? "new.example.com" : null)
  expect(provider.deleteDomain).toHaveBeenNthCalledWith(2, { providerId: "domain-1", domain: stored.documentSendingDomain })
  expect(db.update).toHaveBeenCalledOnce()
})

it.each(operations.filter(operation => operation.method !== "deleteDomain"))(
  "preserves the self-hosted unsupported guard for $path", async (operation) => {
    setRuntimeServices({ managedDocumentDomainProvider: { ...provider, supported: false } })
    expect((await request(operation)).status).toBe(400)
    expect(provider[operation.method]).not.toHaveBeenCalled()
  },
)
