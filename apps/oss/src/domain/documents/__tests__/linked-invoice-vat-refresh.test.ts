import { describe, expect, it, vi } from "vitest"
import { Effect } from "effect"
import { Prisma } from "../../../../generated/prisma/client"
import { Db, Command, type CommandScope } from "../../services"
import { prospectiveRenderInput } from "../render-input"
import { sendInvoice } from "../../commands/invoices"
import { deviationVatLabel } from "../../../lib/documents/line-amounts"
import { buildTotals } from "../../../lib/documents/totals"
// MOCK: database transport, numbering and delivery availability. Both production invoice
// boundaries, linked-seller selection and VAT validation remain real.
vi.mock("../numbering", async importOriginal => ({ ...await importOriginal<typeof import("../numbering")>(),
  numberForIssuance: () => Effect.succeed("INV-0001"),
}))
vi.mock("../invoice-email", async importOriginal => ({ ...await importOriginal<typeof import("../invoice-email")>(),
  resolveInvoiceEmailContext: () => ({ emailDelivery: { available: false } }),
}))
const zero = new Prisma.Decimal(0)
function harness(kind: "quote" | "agreement", taxRegime: "custom" | "us_sales_tax" | "eu_vat", address: string | null, retainedScheme = "cvr", currentCvr?: string) {
  const countryCode = taxRegime === "us_sales_tax" ? "US" : "DK"
  const seller = { companyName: "Agreed seller", companyAddress: address, countryCode, momsRegistered: false, taxIds: [{ scheme: retainedScheme, value: "24256790", countryCode: "DK" }] }
  const line = { id: "line", description: "Synthetic service", quantity: new Prisma.Decimal(1), unitPriceNet: zero, unitPriceGross: zero,
    lineNet: zero, lineTax: zero, lineGross: zero, taxRate: zero, vatRateInput: "0", vatTreatment: "out_of_scope", vatReasonCode: null, vatCountry: null, taxCategory: "standard", taxCode: null }
  const invoice = { id: "invoice", status: "draft", purpose: "sale", agreementId: kind === "agreement" ? "agreement" : null,
    quoteId: kind === "quote" ? "quote" : null, number: null, taxRegime, countryCode, currency: "DKK", locale: "en-GB", timezone: "UTC",
    issueDate: new Date("2026-10-13"), dueDate: new Date("2026-11-09"), supplyDate: new Date("2026-10-13"), pricesIncludeTax: false,
    subtotalNet: zero, totalTax: zero, totalGross: zero, vatEvidence: {}, sellerSnapshot: seller,
    buyerSnapshot: { name: "Agreed buyer", country: "DK" }, items: [line],
    contact: { name: "Current buyer", email: "buyer@example.test", country: "DK", taxIds: [] },
    payments: [], creditNotes: [],
  }
  const update = vi.fn(async ({ data }: { data: object }) => ({ ...invoice, ...data }))
  const db = { $queryRaw: async () => [], invoice: { findFirst: async () => invoice, update },
    orgSettings: { upsert: async () => ({ companyName: "Current seller", companyAddress: "New address", countryCode, momsRegistered: currentCvr ? false : true, baseCurrency: "DKK" }) },
    organizationTaxId: { findMany: async () => currentCvr ? [{ scheme: "cvr", value: currentCvr, countryCode: "DK" }] : [] },
  }
  const command = { organizationId: "org", commandId: "command", now: new Date("2026-10-13"), actor: { kind: "user", roles: ["admin"] },
    emit: vi.fn(), enqueue: vi.fn() } as unknown as CommandScope
  const run = <A, E>(effect: Effect.Effect<A, E, Db | Command>) => Effect.runPromise(Effect.either(effect.pipe(
    Effect.provideService(Db, db as unknown as Prisma.TransactionClient), Effect.provideService(Command, command),
  )))
  return { seller, invoice, update, run }
}
describe("stored line rates at the render-input boundary", () => {
  it.each([
    { currency: "DKK", rates: [0, 25, 5], nets: [100, 100, 100], taxes: [0, 25, 5], main: 25 },
    { currency: "JPY", rates: [25], nets: [105], taxes: [26], main: 25 },
    { currency: "DKK", rates: [0], nets: [100], taxes: [0], main: 0 },
  ])("freezes nominal rates, totals and zero treatments for $currency/$rates without a header rate", async ({ currency, rates, nets, taxes, main }) => {
    const h = harness("quote", "custom", "Old address")
    Object.assign(h.invoice, { calculationVersion: "v2" })
    const decimal = (amount: number) => new Prisma.Decimal(amount)
    h.invoice.currency = currency
    h.invoice.items = rates.map((rate, index) => ({ ...h.invoice.items[0]!, id: `line-${index}`,
      taxRate: decimal(rate), vatRateInput: String(rate / 100), vatTreatment: rate === 0 ? "out_of_scope" : "standard",
      unitPriceNet: decimal(nets[index]!), unitPriceGross: decimal(nets[index]! + taxes[index]!),
      lineNet: decimal(nets[index]!), lineTax: decimal(taxes[index]!), lineGross: decimal(nets[index]! + taxes[index]!),
    }))
    h.invoice.subtotalNet = decimal(nets.reduce((sum, amount) => sum + amount, 0))
    h.invoice.totalTax = decimal(taxes.reduce((sum, amount) => sum + amount, 0))
    h.invoice.totalGross = h.invoice.subtotalNet.plus(h.invoice.totalTax)
    expect(h.invoice).not.toHaveProperty("taxRate")
    const prepared = await h.run(prospectiveRenderInput({ kind: "invoice", documentId: "invoice", number: "INV-1", issuedAt: h.invoice.issueDate, commandInput: {} }))
    if (prepared._tag !== "Right" || prepared.right.kind !== "invoice") throw new Error("Expected invoice render input")
    const rendered = prepared.right.pdf.invoice
    expect(rendered.taxRate).toBe(main)
    expect(rendered.items.map(line => line.taxRate)).toEqual(rates)
    expect(rendered.total).toBe(h.invoice.totalGross.toNumber())
    expect(prepared.right.snapshot).toMatchObject({ invoice: rendered, money: { totals: { gross: h.invoice.totalGross.toFixed(currency === "JPY" ? 0 : 2) } } })
    expect(rates.map(rate => deviationVatLabel(rate, rendered.vatRows, rendered.taxRate))).toEqual(rates.map(rate => rate === main ? null : "pdf.lineVatRate"))
    if (rates.includes(0)) {
      expect(rendered.vatRows).toEqual(expect.arrayContaining([expect.objectContaining({ ratePercent: "0", treatments: ["out_of_scope"] })]))
      expect(buildTotals({ basis: "net", subtotal: rendered.subtotal, taxAmount: rendered.taxAmount, total: rendered.total, vatRows: rendered.vatRows, currency, locale: "en-US" }).lines).toEqual(expect.arrayContaining([expect.objectContaining({ reason: "Outside the scope of VAT" })]))
    }
    h.invoice.status = "sent"
    if (!prepared.right.snapshot || typeof prepared.right.snapshot !== "object" || !("money" in prepared.right.snapshot)) throw new Error("Expected frozen money")
    Object.assign(h.invoice, { number: "INV-1", issuanceSnapshot: prepared.right.snapshot.money })
    const credit = await h.run(prospectiveRenderInput({ kind: "creditNote", documentId: "credit", number: "CN-1", issuedAt: h.invoice.issueDate, commandInput: { invoiceId: "invoice", mode: "full", reason: "Correction" } }))
    if (credit._tag !== "Right" || credit.right.kind !== "creditNote") throw new Error("Expected credit render input")
    expect(credit.right.pdf.creditNote).toMatchObject({ taxRate: main, total: rendered.total, vatRows: rendered.vatRows })
    expect(credit.right.pdf.creditNote.items.map(line => line.taxRate).sort((a, b) => a! - b!)).toEqual([...rates].sort((a, b) => a - b))
  })
})
describe("linked invoice VAT identity scope at production boundaries", () => {
  it.each(["quote", "agreement"] as const)("accepts the supported frozen DK_CVR alias for %s preview and send identity checks after postal edits", async kind => {
    const h = harness(kind, "eu_vat", "Old address", "DK_CVR", "24256790")
    expect(await h.run(prospectiveRenderInput({ kind: "invoice", documentId: "invoice", number: "", issuedAt: new Date("2026-10-13"), commandInput: {}, preview: true }))).toMatchObject({ _tag: "Right", right: { snapshot: { seller: h.seller } } })
    const sent = await h.run(sendInvoice.handle({ id: "invoice", allowSendWithoutEmail: true }))
    // Agreements require issueDocument after the seller identity check succeeds.
    expect(sent).toMatchObject(kind === "agreement" ? { _tag: "Left", left: { code: "issuance_required" } } : { _tag: "Right", right: { status: "sent" } })
    expect(h.update).toHaveBeenCalledTimes(kind === "agreement" ? 0 : 1)
    const changed = harness(kind, "eu_vat", "Old address", "DK_CVR", "12345678")
    expect(await changed.run(prospectiveRenderInput({ kind: "invoice", documentId: "invoice", number: "", issuedAt: new Date("2026-10-13"), commandInput: {}, preview: true }))).toMatchObject({ _tag: "Left", left: { code: "seller_identity_changed" } })
    expect(await changed.run(sendInvoice.handle({ id: "invoice", allowSendWithoutEmail: true }))).toMatchObject({ _tag: "Left", left: { code: "seller_identity_changed" } })
    expect(changed.update).not.toHaveBeenCalled()
  })
  it.each([
    ["quote", "us_sales_tax", null], ["agreement", "us_sales_tax", null],
    ["quote", "custom", null], ["agreement", "custom", null],
    ["quote", "us_sales_tax", "Old address"], ["agreement", "us_sales_tax", "Old address"],
    ["quote", "custom", "Old address"], ["agreement", "custom", "Old address"],
  ] as const)("previews %s/%s with frozen address %s", async (kind, regime, address) => {
    const h = harness(kind, regime, address)
    const result = await h.run(prospectiveRenderInput({ kind: "invoice", documentId: "invoice", number: "", issuedAt: new Date("2026-10-13"), commandInput: {}, preview: true }))
    expect(result).toMatchObject({ _tag: "Right", right: { snapshot: { seller: h.seller } } })
    expect(h.update).not.toHaveBeenCalled()
  })
  it.each(["quote", "agreement"] as const)("still rejects changed Danish EU-VAT %s identity in preview and send", async kind => {
    const h = harness(kind, "eu_vat", "Old address")
    const preview = await h.run(prospectiveRenderInput({ kind: "invoice", documentId: "invoice", number: "", issuedAt: new Date("2026-10-13"), commandInput: {}, preview: true }))
    expect(preview).toMatchObject({ _tag: "Left", left: { code: "seller_identity_changed" } })
    expect(await h.run(sendInvoice.handle({ id: "invoice", allowSendWithoutEmail: true }))).toMatchObject({ _tag: "Left", left: { code: "seller_identity_changed" } })
    expect(h.update).not.toHaveBeenCalled()
  })
  it.each(["custom", "us_sales_tax"] as const)("passes the send identity check for %s", async regime => {
    const h = harness("quote", regime, null)
    const result = await h.run(sendInvoice.handle({ id: "invoice", allowSendWithoutEmail: true }))
    expect(result).toMatchObject({ _tag: "Right", right: { status: "sent" } })
    expect(h.update).toHaveBeenCalledOnce()
  })
})
