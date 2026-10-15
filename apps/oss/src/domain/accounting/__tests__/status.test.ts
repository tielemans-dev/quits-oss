import { describe, expect, it, vi } from "vitest"
import type { PrismaClient } from "../../../../generated/prisma/client"
import { readAccountingStatus } from "../status"

function fakeDb(connection: object | null, done?: Date, failed: Array<{ updatedAt: Date; error: unknown }> = []) {
  return {
    accountingConnection: { findFirst: vi.fn(async () => connection) },
    eventConsumerDelivery: {
      findFirst: vi.fn(async ({ where }: { where: { status: string } }) =>
        where.status === "done" ? (done ? { updatedAt: done, error: null } : null) : (failed[0] ?? null)),
      count: vi.fn(async () => failed.length),
    },
  } as unknown as PrismaClient & { accountingConnection: { findFirst: ReturnType<typeof vi.fn> }; eventConsumerDelivery: { count: ReturnType<typeof vi.fn> } }
}
const dinero = { provider: "dinero", generation: "gen-2", remoteAccountId: "1234" }

describe("readAccountingStatus", () => {
  it("reports both providers as not connected without a connection", async () => {
    const db = fakeDb(null)
    const result = await readAccountingStatus("org", db)
    expect(result.map(({ provider, status }) => [provider, status])).toEqual([["economic", "not_connected"], ["dinero", "not_connected"]])
    expect(db.eventConsumerDelivery.count).not.toHaveBeenCalled()
  })

  it("reads the connected generation's deliveries and never selects the credential", async () => {
    const done = new Date("2026-10-14T09:30:00Z")
    const db = fakeDb(dinero, done)
    expect((await readAccountingStatus("org", db))[1]).toEqual({ provider: "dinero", status: "connected", remoteAccountId: "1234",
      delivery: { lastDeliveredAt: done, failedCount: 0, lastErrorCode: null } })
    expect(db.eventConsumerDelivery.count).toHaveBeenCalledWith({ where: { organizationId: "org", consumerKey: "accounting:dinero:gen-2", status: "failed" } })
    expect(db.accountingConnection.findFirst.mock.calls[0]![0].select).not.toHaveProperty("credentialEnc")
  })

  it("is an error after a failed delivery and ignores a malformed stored error", async () => {
    const economic = { ...dinero, provider: "economic" }
    const read = async (error: unknown) => (await readAccountingStatus("org", fakeDb(economic, undefined, [{ updatedAt: new Date(), error }])))[0]
    expect(await read({ code: "http_401" })).toMatchObject({ status: "error", delivery: { failedCount: 1, lastErrorCode: "http_401" } })
    expect(await read("boom")).toMatchObject({ status: "error", delivery: { lastErrorCode: null } })
  })
})
