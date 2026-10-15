import { describe, expect, it, vi } from "vitest"
import { previewDraft } from "@quits/shared/pricing"
import { getRuntimeCapabilities } from "../../runtime/extensions"
import { fillRequest } from "../request-fallback"

const context = { customers: [{ id: "buyer", name: "Nordlys ApS" }], catalogItems: [] }
const fields = { intent: "invoice", customerQuery: "Nordlys", items: [{ description: "Rådgivning", quantity: "12", unitPrice: "850" }] }
const prompt = "Vil du lave en regning for tolv timers rådgivning til Nordlys?"
const run = (output: unknown = fields, enabled = true, input = prompt) => {
  const complete = vi.fn(async () => JSON.stringify(output))
  const resolve = vi.fn(async () => ({ provider: { id: "openai_compatible" as const, complete }, model: "local" }))
  return { result: fillRequest({ enabled, input, context, resolve }), complete, resolve }
}

describe("request model fallback", () => {
  it("defaults off for self-hosted and hosted runtimes and allows an explicit opt-in", () => {
    for (const distribution of ["selfhost", "cloud"]) {
      expect(getRuntimeCapabilities({ QUITS_DISTRIBUTION: distribution }).aiInvoiceDraft.requestFallbackEnabled).toBe(false)
      expect(getRuntimeCapabilities({ QUITS_DISTRIBUTION: distribution, QUITS_AI_REQUEST_FALLBACK_ENABLED: "true" }).aiInvoiceDraft.requestFallbackEnabled).toBe(true)
    }
  })
  it("supports overdue intent without model-supplied filters or amounts", async () => {
    expect(await run({ intent: "overdue", customerQuery: null, items: [] }).result).toMatchObject({ intent: "overdue", items: [] })
    expect(await run({ intent: "overdue", customerQuery: "Nordlys", items: [] }).result).toBeNull()
  })
  it("does no provider setup or calls with the flag off", async () => {
    const test = run(fields, false)
    expect(await test.result).toBeNull()
    expect(test.resolve).not.toHaveBeenCalled()
    expect(test.complete).not.toHaveBeenCalled()
  })
  it.each(["faktura til Nordlys 12 timer à 850 kr.", "betaling modtaget fra Havbrise 1.250,50 kr ref F-1042"])("leaves deterministic requests to the parser: %s", async input => {
    const test = run(fields, true, input)
    expect(await test.result).toBeNull()
    expect(test.complete).not.toHaveBeenCalled()
  })
  it("validates fields and matches customers locally without sending the customer list", async () => {
    const test = run()
    expect(await test.result).toMatchObject({ intent: "invoice", customer: { status: "matched", candidates: context.customers }, items: fields.items })
    expect(JSON.stringify(test.complete.mock.calls)).not.toContain("Nordlys ApS")
  })
  it.each([
    { ...fields, total: 1 }, { ...fields, dueDate: "2030-01-01" }, { ...fields, taxRate: 0 },
    { ...fields, intent: "send" }, { ...fields, customerQuery: "Invented Ltd" },
    { ...fields, items: [{ ...fields.items[0], quantity: "-1" }] },
    { ...fields, items: [{ ...fields.items[0], unitPrice: "NaN" }] },
  ])("returns search for invalid output", async output => {
    expect(await run(output).result).toBeNull()
  })
  it("returns search for malformed JSON, missing providers and provider failures", async () => {
    for (const complete of [async () => "not JSON", async () => { throw new Error("private upstream text") }]) {
      expect(await fillRequest({ enabled: true, input: prompt, context, resolve: async () => ({ provider: { id: "openrouter", complete }, model: "test" }) })).toBeNull()
    }
    expect(await fillRequest({ enabled: true, input: prompt, context, resolve: async () => { throw new Error("not configured") } })).toBeNull()
  })
  it("uses the form's totals for the same fields", async () => {
    const draft = await run().result
    const preview = previewDraft({ items: draft!.items.map(line => ({ description: line.description, quantity: line.quantity!, unitPrice: line.unitPrice! })), taxRate: "25", pricesIncludeTax: false, currency: "DKK" })
    expect(preview.result).toMatchObject({ net: "10200.00", tax: "2550.00", gross: "12750.00" })
  })
})
