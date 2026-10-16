import { createHash } from "node:crypto"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { EventConsumerDelivery, Prisma, PrismaClient } from "../../../../generated/prisma/client"
import { claim, complete, fail } from "../../events/consumers"
import { deliverAccounting, type AccountingConnections, type AccountingTransport } from "../delivery"
import { dineroProvider } from "../dinero"
import { economicProvider } from "../economic"
import { equalTotals, fingerprint } from "../safeguards"
import { creditFixture, invoiceFixture } from "./fixtures"

vi.mock("../../events/consumers", () => ({ scan: vi.fn(), advance: vi.fn(), claim: vi.fn(), complete: vi.fn(), fail: vi.fn() }))
beforeEach(() => vi.resetAllMocks())
function setup(providerId = "dinero", credit = false, prices = ["1"]) {
  const invoice = invoiceFixture({ lines: prices.map((unitPrice, sortOrder) => ({ unitPrice, sortOrder, quantity: "1", vat: { treatment: "standard", rate: "0.25", country: "DK" } })) })
  invoice.buyer = { name: "Buyer", country: "DK" }
  const event = { id: "event", aggregateId: credit ? "credit" : "invoice", type: credit ? "credit_note.issued" : "invoice.issued",
    schemaVersion: credit ? 2 : 1, payload: credit ? creditFixture(invoice) : invoice }
  const row = { id: "delivery", status: "pending", attempts: 0, prepared: null, evidence: null, externalRef: null } as EventConsumerDelivery
  const document = { subtotalNet: "1", totalTax: "0.25", totalGross: "1.25" }
  const updateMany = vi.fn(async ({ data }: { data: Partial<EventConsumerDelivery> }) => { Object.assign(row, structuredClone(data)); return { count: 1 } })
  const db = { domainEvent: { findUniqueOrThrow: async () => event }, invoice: { findFirst: async () => document },
    creditNote: { findFirst: async () => document }, eventConsumerDelivery: { findFirst: async () => row, findMany: async () => [], updateMany } } as unknown as PrismaClient
  vi.mocked(claim).mockImplementation(async () => { row.attempts++; row.status = "claimed"; row.claimToken = "lease"; return [structuredClone(row)] as Awaited<ReturnType<typeof claim>> })
  vi.mocked(fail).mockImplementation(async input => { row.status = "failed"; row.error = input.error as Prisma.JsonValue; return { fenced: false } })
  vi.mocked(complete).mockImplementation(async input => { row.status = "done"; row.externalRef = input.externalRef!; return { fenced: false } })
  const guid = "11111111-1111-4111-8111-111111111111", key = invoice.vatGroups[0]!.key
  type Payload = { path: string; body: Prisma.InputJsonValue }
  type Connection = NonNullable<Awaited<ReturnType<AccountingConnections<void, Payload>["find"]>>>
  const connection: Connection = {
    key: "generation", mappingRevision: "1", settings: vi.fn(), request: vi.fn((mapped: Parameters<Connection["request"]>[0]) => mapped.payload),
    provider: { id: providerId, supportsDelivery: dineroProvider.supportsDelivery, map: e => {
      if (providerId === "dinero") return dineroProvider.map(e, { contactGuid: guid, documentGuid: guid,
        invoiceLinks: { invoice: guid }, vatMappings: { [key]: { accountNumber: 1000 } } })
      const mapped = economicProvider.map(e, { customerNumber: 1, layoutNumber: 1, paymentTermsNumber: 1,
        vatMappings: { [key]: { productNumber: "sales", vatZoneNumber: 1 } } })
      return mapped.status === "refused" ? mapped : { ...mapped, payload: { path: "/invoices/drafts", body: mapped.payload } }
    } },
  }
  const transport: AccountingTransport = { send: vi.fn(async (request: Parameters<AccountingTransport["send"]>[0]) => ({ status: 201, externalRef: "voucher-42", totals: request.expectedTotals })),
    reconcile: vi.fn(async () => ({ status: "absent" as const })) }
  const run = () => deliverAccounting({ organizationId: "org", connections: { find: async () => connection }, transport }, db)
  return { event, row, document, connection, transport, run, updateMany }
}
describe("delivery safeguards with fake transport", () => {
  it.each(["pending", "failed"] as const)("clears a legacy %s unsupported payment from the queue", async status => {
    const f = setup()
    f.event.type = "payment.recorded"; f.row.status = status
    expect(await f.run()).toBe("skipped")
    expect(f.row).toMatchObject({ status: "skipped", error: { code: "event_not_applicable" } })
    expect(claim).not.toHaveBeenCalled()
    expect(f.transport.send).not.toHaveBeenCalled()
  })
  it.each(["economic", "dinero"])("checks %s invoice and credit totals and records the remote voucher", async provider => {
    for (const credit of [false, true]) {
      const f = setup(provider, credit)
      expect(await f.run()).toBe("delivered")
      expect(f.row.response).toEqual({ externalRef: "voucher-42", totals: { net: credit ? "-1.00" : "1.00", tax: credit ? "-0.25" : "0.25", gross: credit ? "-1.25" : "1.25" } })
      expect(f.row.evidence).toMatchObject({ source: { payload: { totals: f.event.payload.totals } } })
    }
  })
  it.each(["economic", "dinero"])("blocks a changed %s HTTP line without sending", async provider => {
    const f = setup(provider)
    vi.mocked(f.connection.request).mockImplementation(mapped => ({ ...mapped.payload, body: provider === "economic"
      ? { currency: "DKK", lines: [{ quantity: 1, unitNetPrice: 1.01 }] }
      : { Currency: "DKK", ShowLinesInclVat: false, ProductLines: [{ Quantity: 1, BaseAmountValue: 1.01, Discount: 0 }] } }))
    expect(await f.run()).toBe("failed")
    expect(f.row.error).toMatchObject({ code: "payload_totals_mismatch", message: expect.stringContaining("Nothing was sent") })
    expect(f.transport.send).not.toHaveBeenCalled()
  })
  it.each(["net", "tax", "gross"] as const)("checks document %s independently of the mapper", async field => {
    const f = setup(), map = f.connection.provider.map
    f.connection.provider.map = (event, settings) => {
      const mapped = map(event, settings)
      return mapped.status === "refused" ? mapped : { ...mapped, expectedTotals: { ...mapped.expectedTotals, [field]: "9.99" } }
    }
    expect(await f.run()).toBe("failed")
    expect(f.row.error).toMatchObject({ code: "payload_totals_mismatch" })
    expect(f.transport.send).not.toHaveBeenCalled()
  })
  it.each(["economic", "dinero"])("checks individual %s lines even when document totals still match", async provider => {
    const f = setup(provider, false, ["1", "1"])
    vi.mocked(f.connection.request).mockImplementation(mapped => ({ ...mapped.payload, body: provider === "economic"
      ? { currency: "DKK", lines: [1.01, 0.99].map(unitNetPrice => ({ quantity: 1, unitNetPrice })) }
      : { Currency: "DKK", ShowLinesInclVat: false, ProductLines: [1.01, 0.99].map(BaseAmountValue => ({ Quantity: 1, BaseAmountValue, Discount: 0 })) } }))
    expect(await f.run()).toBe("failed")
    expect(f.row.error).toMatchObject({ code: "payload_totals_mismatch" })
    expect(f.transport.send).not.toHaveBeenCalled()
  })
  it.each(["net", "tax", "gross"] as const)("flags provider %s discrepancies and retains evidence across retry", async field => {
    const f = setup()
    vi.mocked(f.transport.send).mockImplementationOnce(async request => ({ status: 201, externalRef: "booked-42", totals: { ...request.expectedTotals, [field]: "9.99" } }))
    expect(await f.run()).toBe("failed")
    expect(f.row).toMatchObject({ externalRef: "booked-42", response: { totals: { [field]: "9.99" } }, error: { code: "provider_totals_mismatch" } })
    f.row.status = "pending"; f.row.attempts = 0
    expect(await f.run()).toBe("failed")
    expect(f.transport.send).toHaveBeenCalledTimes(1)
  })
  it("replays identical requests after mapping changes, and reconciles a lost response with totals", async () => {
    const f = setup()
    vi.mocked(f.transport.send).mockRejectedValueOnce(new Error("lost response"))
    expect(await f.run()).toBe("pending")
    f.connection.settings = vi.fn(() => { throw new Error("must not remap") })
    expect(await f.run()).toBe("delivered")
    const calls = vi.mocked(f.transport.send).mock.calls
    expect(calls[0][0]).toEqual(calls[1][0])
    const recovered = setup()
    vi.mocked(recovered.transport.send).mockRejectedValueOnce(new Error("lost response"))
    await recovered.run()
    vi.mocked(recovered.transport.reconcile).mockResolvedValueOnce({ status: "delivered", externalRef: "recovered", totals: { net: "1", tax: "0.25", gross: "1.25" } })
    expect(await recovered.run()).toBe("delivered")
    expect(recovered.transport.send).toHaveBeenCalledTimes(1)
  })
  it.each(["event", "document", "missing evidence"])("requires review after %s changes following a failed attempt", async change => {
    const f = setup()
    vi.mocked(f.transport.send).mockResolvedValueOnce({ status: 400 })
    await f.run()
    if (change === "event") f.event.payload.lines[0]!.description = "Changed"
    else if (change === "document") f.document.totalGross = "2.00"
    else f.row.evidence = null
    f.row.status = "pending"; f.row.attempts = 0
    expect(await f.run()).toBe("failed")
    expect(f.row.error).toMatchObject({ code: "source_review_required" })
    expect(f.transport.send).toHaveBeenCalledTimes(1)
  })
  it("rejects absent provider totals without losing the returned reference", async () => {
    const f = setup()
    vi.mocked(f.transport.send).mockResolvedValueOnce({ status: 201, externalRef: "accepted" })
    expect(await f.run()).toBe("failed")
    expect(f.row).toMatchObject({ externalRef: "accepted", error: { code: "reconciliation_required" } })
  })
  it("flags mismatched totals recovered after a lost response without resending", async () => {
    const f = setup()
    vi.mocked(f.transport.send).mockRejectedValueOnce(new Error("lost response"))
    await f.run()
    vi.mocked(f.transport.reconcile).mockResolvedValueOnce({ status: "delivered", externalRef: "recovered", totals: { net: "1", tax: "0.24", gross: "1.24" } })
    expect(await f.run()).toBe("failed")
    expect(f.row).toMatchObject({ externalRef: "recovered", error: { code: "provider_totals_mismatch" } })
    expect(f.transport.send).toHaveBeenCalledTimes(1)
  })
  it("freezes source evidence even when the first mapping attempt is refused", async () => {
    const f = setup()
    f.connection.provider.map = () => ({ status: "refused", code: "missing_mapping", detail: "Missing account" })
    expect(await f.run()).toBe("failed")
    expect(f.row.evidence).toMatchObject({ source: { payload: { totals: f.event.payload.totals } } })
    f.document.totalGross = "2"
    f.row.status = "pending"; f.row.attempts = 0
    expect(await f.run()).toBe("failed")
    expect(f.row.error).toMatchObject({ code: "source_review_required" })
    expect(f.transport.send).not.toHaveBeenCalled()
  })
  it("hashes nested keys in UTF-16 order without locale collation", () => {
    const canonical = '{"Z":[{"Z":1,"a":2,"ä":3}],"a":4,"ä":5}'
    expect(fingerprint({ ä: 5, a: 4, Z: [{ ä: 3, a: 2, Z: 1 }] })).toBe(createHash("sha256").update(canonical).digest("hex"))
    expect(fingerprint([1, 2])).not.toBe(fingerprint([2, 1]))
  })
  it("compares large minor units exactly, refuses sub-minor units, and ignores JSON key order", () => {
    const totals = { net: "90071992547409.91", tax: "0", gross: "90071992547409.91" }
    expect(equalTotals(totals, { ...totals, net: "90071992547409.92" })).toBe(false)
    expect(equalTotals(totals, { ...totals, tax: "0.001" })).toBe(false)
    expect(fingerprint({ b: 1, a: { y: 2, x: 3 } })).toBe(fingerprint({ a: { x: 3, y: 2 }, b: 1 }))
  })
})
