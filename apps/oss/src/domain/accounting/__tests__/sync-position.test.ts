import { describe, expect, it, vi } from "vitest"
import type { Prisma } from "../../../../generated/prisma/client"
import { accountingDispositions } from "../sync-position"
import { dineroProvider } from "../dinero"
import { economicProvider } from "../economic"
import { retryAvailableAt } from "../delivery"

const start = new Date("2026-10-01"), reconnect = new Date("2026-10-10")
const scope = { organizationId: "org", consumerKey: "accounting:dinero:new" }
async function classify(history: object[] = [], date = start, connection = { syncStartAt: start, reviewBefore: null as Date | null }) {
  const findMany = vi.fn(async () => history)
  const db = { eventConsumerDelivery: { findMany } } as unknown as Prisma.TransactionClient
  const rows = await accountingDispositions(scope, connection, [{ sequence: 1, occurredAt: date, type: "invoice.issued", aggregateId: "invoice" }], db)
  expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { organizationId: "org",
    consumerKey: { startsWith: "accounting:", not: scope.consumerKey }, sequence: { in: [1] } } }))
  return rows.get(1)
}

describe("accounting sync positions", () => {
  it.each([economicProvider, dineroProvider])("skips unsupported payments for $id without blocking later documents", async provider => {
    const events = ["payment.recorded", "invoice.issued", "credit_note.issued"].map((type, i) => ({ type, sequence: i + 1, occurredAt: start, aggregateId: "invoice" }))
    const db = { eventConsumerDelivery: { findMany: async () => [] } } as unknown as Prisma.TransactionClient
    const rows = await accountingDispositions(scope, { provider }, events, db)
    expect([...rows.values()]).toEqual([{ status: "skipped", error: { code: "event_not_applicable" } }, { status: "pending" }, { status: "pending" }])
  })
  it.each([true, false])("skips a later payment only when its invoice predates the sync start: %s", async excluded => {
    const findMany = vi.fn(async () => excluded ? [{ aggregateId: "invoice" }] : [])
    const db = { domainEvent: { findMany }, eventConsumerDelivery: { findMany: async () => [] } } as unknown as Prisma.TransactionClient
    const rows = await accountingDispositions(scope, { syncStartAt: start }, [{ type: "payment.recorded", aggregateId: "invoice", sequence: 2, occurredAt: reconnect }], db)
    expect(rows.get(2)).toEqual(excluded ? { status: "skipped", error: { code: "invoice_before_sync_start" } } : { status: "pending" })
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { organizationId: "org", type: "invoice.issued", occurredAt: { lt: start }, aggregateId: { in: ["invoice"] } } }))
  })
  it.each([Number.MAX_VALUE, 172800000, Infinity, NaN, -1, 120000])("bounds Retry-After %s to a valid retry date", delay => {
    const date = retryAvailableAt(start, delay, 1000)
    expect(date.getTime() - start.getTime()).toBe(Number.isFinite(delay) ? Math.max(1000, Math.min(86400000, delay)) : 1000)
    expect(Number.isFinite(retryAvailableAt(new Date(NaN), delay, 1000).getTime())).toBe(true)
    expect(Number.isFinite(retryAvailableAt(new Date(8.64e15 - 1000), delay, 1000).getTime())).toBe(true)
  })
  it("excludes older events and includes the exact chosen start", async () => {
    expect(await classify([], new Date(start.getTime() - 1))).toEqual({ status: "skipped" })
    expect(await classify()).toEqual({ status: "pending" })
  })
  it.each(["done", "skipped"])("keeps a previous %s terminal across accounts", async status => {
    expect(await classify([{ sequence: 1, status }, { sequence: 1, status: "failed" }])).toEqual({ status: "skipped" })
  })
  it.each(["pending", "failed", "claimed"])("requires a decision for an old-generation %s delivery", async status => {
    expect(await classify([{ id: "old-delivery", sequence: 1, status }])).toEqual({ status: "failed",
      error: { code: "reconnect_review_required", previousDeliveryId: "old-delivery" } })
  })
  it("also holds unscanned history from before reconnect, but allows new events", async () => {
    const connection = { syncStartAt: start, reviewBefore: reconnect }
    expect(await classify([], start, connection)).toMatchObject({ status: "failed", error: { code: "reconnect_review_required" } })
    expect(await classify([], reconnect, connection)).toEqual({ status: "pending" })
  })
  it("retains the original request through repeated reconnect decisions", async () => {
    expect(await classify([{ id: "intermediate", sequence: 1, status: "failed",
      error: { code: "reconnect_review_required", previousDeliveryId: "original" } }])).toMatchObject({ error: { previousDeliveryId: "original" } })
  })
})
