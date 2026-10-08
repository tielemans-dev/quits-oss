import { describe, expect, it } from "vitest"
import { documentViewSchema } from "@quits/contracts/document-view"
import type { DocumentLineInput } from "@quits/contracts/invoices"
import { buildDraftView, buildIssuedView } from "@quits/shared/documents"
import { Prisma } from "../../../../generated/prisma/client"
import { frozenInvoiceLine, frozenTotals } from "../../agreements/billing"
import { draftViewInputFromRows } from "../view"
import { invoiceMoneySnapshot } from "../money-snapshot"
import { priceDocument, priceDocumentV2 } from "../pricing"

/**
 * The draft view must say what the server stores, and what the invoice will say once it is issued.
 * Both are produced by the app's real writers (`priceDocumentV2`, `priceDocument`, `frozenInvoiceLine`,
 * `invoiceMoneySnapshot`), not restated from `calculateDraft`.
 */

const dec = (value: string | number) => new Prisma.Decimal(value)
type Pricing = { [key: string]: unknown }

/** A stored `InvoiceItem`: what the writers produce, as the database returns it. */
function storedItem(row: Pricing, id: string) {
  return {
    ...row, id, description: row.description as string,
    clientKey: (row.clientKey as string | undefined) ?? null, deliverableId: (row.deliverableId as string | undefined) ?? null,
    sortOrder: (row.sortOrder as number | undefined) ?? 0, taxCategory: (row.taxCategory as string | undefined) ?? "standard", taxCode: null,
    quantity: dec(row.quantity as string | number), unitPriceNet: dec(row.unitPriceNet as string | number), unitPriceGross: dec(row.unitPriceGross as string | number),
    lineNet: dec(row.lineNet as string | number), lineTax: dec(row.lineTax as string | number), lineGross: dec(row.lineGross as string | number),
    taxRate: dec(row.taxRate as string | number),
    quantityInput: (row.quantityInput as string | undefined) ?? null, unitPriceInput: (row.unitPriceInput as string | undefined) ?? null,
    inputPrecision: (row.inputPrecision as string | undefined) ?? null, vatRateInput: (row.vatRateInput as string | undefined) ?? null,
    vatTreatment: (row.vatTreatment as string | undefined) ?? "standard", vatCountry: (row.vatCountry as string | undefined) ?? null,
    vatReasonCode: (row.vatReasonCode as string | undefined) ?? null,
  }
}
type StoredItem = ReturnType<typeof storedItem>

const timezone = "Europe/Copenhagen"

/** The invoice as the issuing code reads it, and the money snapshot it freezes. */
function issuedViewOf(document: { currency: string; pricesIncludeTax: boolean; calculationVersion: "v2" | "legacy_per_line"; items: StoredItem[] }) {
  const invoice = {
    id: "invoice", purpose: "sale", currency: document.currency, timezone, dueDate: new Date("2026-11-07T10:00:00Z"), supplyDate: new Date("2026-10-07T10:00:00Z"),
    calculationVersion: document.calculationVersion, pricesIncludeTax: document.pricesIncludeTax, agreementId: null, quoteId: null, recurringInvoiceId: null,
    vatEvidence: null, items: document.items,
  } as unknown as Parameters<typeof invoiceMoneySnapshot>[0]
  const snapshot = invoiceMoneySnapshot(invoice, { number: "INV-0001", issuedAt: new Date("2026-10-07T10:00:00Z"), baseCurrency: document.currency, seller: {}, buyer: {} })
  return buildIssuedView(snapshot, { kind: "invoice", status: "sent", locale: "da-DK", timezone })
}

type Document = ReturnType<typeof storedDocument>

/** Database document fields, without adapting any line into view input. */
function storedDocument(input: {
  currency: string; pricesIncludeTax: boolean; calculationVersion: "v2" | "legacy_per_line";
  items: StoredItem[]; taxRate: string; totals: { net: string; tax: string; gross: string }
}) {
  return {
    ...input, status: "draft", number: null, locale: "da-DK", timezone, contactId: "contact",
    sellerSnapshot: null, buyerSnapshot: null, vatEvidence: null, notes: null,
    issueDate: new Date("2026-10-07T10:00:00Z"),
    subtotalNet: dec(input.totals.net), totalTax: dec(input.totals.tax), totalGross: dec(input.totals.gross),
  }
}

/** A v2 draft stored by the production pricing writer. */
function v2Document(input: { items: DocumentLineInput[]; taxRate: string; pricesIncludeTax: boolean; currency: string }): Document {
  const priced = priceDocumentV2(input)
  const items = priced.itemRows.map((row, index) => storedItem(row as Pricing, `item-${index}`))
  return storedDocument({ ...input, calculationVersion: "v2", items, totals: { net: priced.subtotalNet, tax: priced.totalTax, gross: priced.totalGross } })
}

/** Frozen agreement rows and separately priced extras, as the linked invoice writer stores them. */
function linkedRows(input: {
  frozen: Array<Pricing>; unlinked: DocumentLineInput[]; taxRate: string; pricesIncludeTax: boolean; currency: string; calculationVersion: "v2" | "legacy_per_line"
}): Document {
  const deliverables = input.frozen.map((row, index) => ({ ...storedItem(row, `deliverable-${index}`), title: String(row.description) }))
  const frozenRows = deliverables.map((deliverable, index) => frozenInvoiceLine(deliverable as never, index, input.pricesIncludeTax))
  const frozen = frozenRows.map((row, index) => storedItem(row as Pricing, `frozen-${index}`))
  const priced = priceDocumentV2({ items: input.unlinked.map((item) => ({ ...item, vat: undefined })), taxRate: input.taxRate, pricesIncludeTax: input.pricesIncludeTax, currency: input.currency })
  const unlinked = priced.itemRows.map((row, index) => storedItem(row as Pricing, `unlinked-${index}`))
  const items = [...frozen, ...unlinked]
  const totals = frozenTotals(items)
  return storedDocument({ ...input, items, totals: { net: totals.subtotalNet.toFixed(), tax: totals.totalTax.toFixed(), gross: totals.totalGross.toFixed() } })
}

/** A draft written by the legacy per-line calculation. */
function legacyDocument(input: { items: Array<{ description: string; quantity: number; unitPrice: number }>; taxRate: number; pricesIncludeTax: boolean; currency: string }): Document {
  const priced = priceDocument(input)
  const items = priced.itemRows.map((row, index) => storedItem(row as Pricing, `item-${index}`))
  return storedDocument({ ...input, calculationVersion: "legacy_per_line", items, taxRate: String(input.taxRate),
    totals: { net: String(priced.subtotalNet), tax: String(priced.totalTax), gross: String(priced.totalGross) } })
}

// ---- the comparison ----

const exponentOf = (currency: string) => currency === "JPY" ? 0 : 2
const money = (value: string, currency: string) => new Prisma.Decimal(value).toFixed(exponentOf(currency))

function expectParity(document: Document, label: string) {
  const view = buildDraftView(draftViewInputFromRows("invoice", document))
  const context = `${label}: ${JSON.stringify(document.items)}`
  expect(documentViewSchema.parse(view), context).toEqual(view)

  // What the server stored for the draft.
  expect(view.totals, context).not.toBeNull()
  expect(
    { net: view.totals!.net, tax: view.totals!.tax, gross: view.totals!.gross },
    context
  ).toEqual({ net: money(document.totals.net, document.currency), tax: money(document.totals.tax, document.currency), gross: money(document.totals.gross, document.currency) })

  // What the issued document will say.
  const issued = issuedViewOf(document)
  const line = (l: (typeof view)["lines"][number]) => ({
    description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, unitPriceNet: l.unitPriceNet, vat: l.vat, net: l.net, tax: l.tax, gross: l.gross, amount: l.amount,
  })
  expect(view.lines.map(line), context).toEqual(issued.lines.map(line))
  expect(view.vatGroups, context).toEqual(issued.vatGroups)
  expect(view.totals, context).toEqual(issued.totals)
  expect(view.calculation.version, context).toBe(issued.calculation.version)
  expect(view.pricesIncludeTax).toBe(issued.pricesIncludeTax)

  // The printed column adds up to the document, on either price basis.
  const printed = view.lines.reduce((total, l) => total.plus(l.amount!), new Prisma.Decimal(0))
  expect(printed.toFixed(view.exponent), context).toBe(document.pricesIncludeTax ? view.totals!.gross : view.totals!.net)
  return { view, issued }
}

// ---- named cases ----

const standard25 = { treatment: "standard", rate: "0.25", country: "DK" } as const
const exempt = { treatment: "exempt", rate: "0", reasonCode: "financial" } as const
const intra = { treatment: "intra_community", rate: "0", reasonCode: "services_b2b", country: "DE" } as const

describe("the draft view against the app's own writers", () => {
  it("uses the first positive nominal rate after an exempt line", () => {
    const document = v2Document({ currency: "DKK", taxRate: "25", pricesIncludeTax: false, items: [
      { description: "Exempt first", quantity: "1", unitPrice: "100", vat: exempt },
      { description: "Standard second", quantity: "1", unitPrice: "100", vat: standard25 },
    ] })
    expect(draftViewInputFromRows("invoice", document).taxRate).toBe(25)
    expectParity(document, "exempt first")
  })

  for (const pricesIncludeTax of [false, true]) {
    it(`prices a v2 draft as the server stores it (pricesIncludeTax: ${pricesIncludeTax})`, () => {
      const document = v2Document({
        currency: "DKK", taxRate: "25", pricesIncludeTax,
        items: [
          { description: "Work", quantity: "3", unitPrice: "100.50" },
          { description: "Training", quantity: "1", unitPrice: "40", vat: exempt },
          { description: "Consulting", quantity: "0.5", unitPrice: "1999.99", vat: intra },
          { description: "Penny", quantity: "1", unitPrice: "0.01", vat: standard25 },
          { description: "Penny", quantity: "1", unitPrice: "0.01", vat: standard25 },
        ],
      })
      expectParity(document, "mixed v2")
    })
  }

  it("keeps the frozen lines of an agreement-linked draft and prices only the unlinked ones", () => {
    const frozenAgreement = priceDocumentV2({
      currency: "DKK", taxRate: "25", pricesIncludeTax: false,
      items: [{ description: "Milestone 1", quantity: "1", unitPrice: "0.10" }, { description: "Milestone 2", quantity: "1", unitPrice: "0.20", vat: exempt }],
    }).itemRows
    const document = linkedRows({
      frozen: frozenAgreement as Pricing[], unlinked: [{ description: "Extra", quantity: "2", unitPrice: "0.10" }],
      taxRate: "25", pricesIncludeTax: false, currency: "DKK", calculationVersion: "v2",
    })
    const { view } = expectParity(document, "linked")
    expect(view.lines.map((l) => l.locked)).toEqual([true, true, false])
  })

  it("shows a legacy draft's stored amounts, which is what is issued, not a v2 repricing", () => {
    const document = legacyDocument({ currency: "DKK", taxRate: 25, pricesIncludeTax: false, items: [{ description: "A", quantity: 1, unitPrice: 0.1 }, { description: "B", quantity: 1, unitPrice: 0.1 }] })
    const { view } = expectParity(document, "legacy")
    expect(view.totals).toMatchObject({ net: "0.20", tax: "0.06", gross: "0.26" })
    expect(view.calculation).toEqual({ version: "legacy_per_line", staleLegacy: true })
  })

  it("reads the rows the legacy migration wrote: unclassified zero, with a two-decimal quantity", () => {
    const migrated = storedItem({
      description: "Fixed fee", quantity: 3, unitPriceNet: 100, unitPriceGross: 100, lineNet: 300, lineTax: 0, lineGross: 300, taxRate: 0,
      taxCategory: "standard", sortOrder: 0, vatTreatment: "unclassified_zero", quantityInput: "3.00", unitPriceInput: "100.00", inputPrecision: "backfilled", vatRateInput: null,
    }, "migrated")
    const document = storedDocument({
      currency: "DKK", pricesIncludeTax: false, calculationVersion: "legacy_per_line", items: [migrated], taxRate: "0",
      totals: { net: "300", tax: "0", gross: "300" },
    })
    const { view } = expectParity(document, "migrated legacy row")
    expect(view.lines[0]).toMatchObject({ quantity: "3.00", unitPrice: "100.00", unitPriceNet: "100.00", vat: { treatment: "unclassified_zero", rate: "0", reasonCode: null } })
    expect(view.calculation).toEqual({ version: "legacy_per_line", staleLegacy: true })
  })

  it("reprices every unlocked line together unless all of them are stored", () => {
    const document = v2Document({
      currency: "DKK", taxRate: "25", pricesIncludeTax: true,
      items: [{ description: "Penny", quantity: "1", unitPrice: "0.01" }, { description: "Penny", quantity: "1", unitPrice: "0.01" }],
    })
    // The server stores 0.01 tax for the pair. Pricing the second line alone would give 0.00.
    expect(document.totals.tax).toBe("0.01")
    const all = expectParity(document, "all stored").view
    expect(all.totals?.tax).toBe("0.01")
    const input = draftViewInputFromRows("invoice", document)
    expect(input.lines.every(line => line.stored && line.vat)).toBe(true)
    const partial = buildDraftView({ ...input, lines: input.lines.map((line, index) => index === 1 ? line : { ...line, stored: undefined }) })
    expect(partial.totals?.tax).toBe("0.01")
    expect(partial).toEqual(buildDraftView(draftViewInputFromRows("invoice", document)))
  })

  it("reads a legacy agreement's zero-rate line as out of scope, as the invoice copy does", () => {
    const legacyFrozen = legacyDocument({ currency: "DKK", taxRate: 0, pricesIncludeTax: false, items: [{ description: "Fixed fee", quantity: 1, unitPrice: 100 }] }).items
    const document = linkedRows({
      frozen: legacyFrozen.map((item) => ({ ...item, lineNet: item.lineNet.toString(), lineTax: item.lineTax.toString(), lineGross: item.lineGross.toString() })) as Pricing[],
      unlinked: [{ description: "Extra", quantity: "1", unitPrice: "10" }], taxRate: "0", pricesIncludeTax: false, currency: "DKK", calculationVersion: "legacy_per_line",
    })
    const { view } = expectParity(document, "legacy linked, zero rate")
    expect(view.vatGroups.map((g) => g.treatment)).toEqual(["out_of_scope"])
  })
})

// ---- generated cases ----

/** mulberry32: deterministic, so a failure reproduces. */
function random(seed: number) {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function generate(r: () => number, index: number): { label: string; document: Document } {
  const pick = <T,>(values: readonly T[]) => values[Math.floor(r() * values.length)]!
  const count = 1 + Math.floor(r() * 6)
  const currency = pick(["DKK", "EUR", "JPY"])
  const pricesIncludeTax = r() < 0.5
  const quantity = () => pick(["1", "2", "3", "0.5", "1.5", "2.25", "10", "0.333333", "7.5"])
  const price = () => {
    const decimals = Math.floor(r() * 5)
    const whole = Math.floor(r() * (currency === "JPY" ? 100_000 : 2_000))
    return decimals ? `${whole}.${Array.from({ length: decimals }, () => Math.floor(r() * 10)).join("")}` : String(whole)
  }
  const lines = (vats: ReadonlyArray<DocumentLineInput["vat"]>): DocumentLineInput[] =>
    Array.from({ length: count }, (_, i) => ({ description: `Line ${i}`, quantity: quantity(), unitPrice: price(), vat: pick(vats) }))
  // Out of scope cannot be priced with anything else, so a zero-rate document holds only it.
  const standardMix = [undefined, standard25, { treatment: "standard", rate: "0.2" }, exempt, intra, { treatment: "export", rate: "0", reasonCode: "goods_outside_eu" }] as const
  const outOfScope = [undefined, { treatment: "out_of_scope", rate: "0" }] as const
  const kind = index % 10
  const label = `#${index} ${currency} ${pricesIncludeTax ? "inclusive" : "exclusive"}`

  if (kind <= 4) {
    const zero = r() < 0.15
    return { label: `${label} v2${zero ? " zero" : ""}`, document: v2Document({ currency, pricesIncludeTax, taxRate: zero ? "0" : pick(["25", "25", "19.5", "8"]), items: lines(zero ? outOfScope : standardMix) }) }
  }
  if (kind <= 7) {
    // Each deliverable was priced on its own when the agreement was made, with its own classification.
    const agreementRate = pick(["25", "25", "0"])
    const frozen = Array.from({ length: 1 + Math.floor(r() * 3) }, (_, i) => priceDocumentV2({
      currency, pricesIncludeTax, taxRate: agreementRate,
      items: [{ description: `Milestone ${i}`, quantity: quantity(), unitPrice: price(), vat: pick([undefined, standard25, exempt]) }],
    }).itemRows).flat()
    return {
      label: `${label} linked`,
      document: linkedRows({
        frozen: frozen as Pricing[], unlinked: lines([undefined]).slice(0, Math.floor(r() * 3)), taxRate: agreementRate, pricesIncludeTax, currency, calculationVersion: "v2",
      }),
    }
  }
  if (kind === 8) {
    return {
      label: `${label} legacy`,
      document: legacyDocument({
        currency, pricesIncludeTax, taxRate: pick([25, 25, 12.5, 8]),
        items: Array.from({ length: count }, (_, i) => ({ description: `Line ${i}`, quantity: pick([1, 2, 3, 0.5, 1.5, 2.25, 10]), unitPrice: Math.round(r() * 200_000) / 100 })),
      }),
    }
  }
  const rate = pick([25, 0])
  const frozen = legacyDocument({
    currency, pricesIncludeTax, taxRate: rate,
    items: Array.from({ length: 1 + Math.floor(r() * 3) }, (_, i) => ({ description: `Milestone ${i}`, quantity: pick([1, 2, 0.5]), unitPrice: Math.round(r() * 100_000) / 100 })),
  }).items
  return {
    label: `${label} legacy linked`,
    document: linkedRows({
      frozen: frozen.map((item) => ({ ...item, lineNet: item.lineNet.toString(), lineTax: item.lineTax.toString(), lineGross: item.lineGross.toString() })) as Pricing[],
      unlinked: lines([undefined]).slice(0, Math.floor(r() * 3)), taxRate: String(rate), pricesIncludeTax, currency, calculationVersion: "legacy_per_line",
    }),
  }
}

describe("generated drafts", () => {
  const cases = 500
  it(`match the stored totals and the issued view in ${cases} seeded cases`, () => {
    const r = random(20261009)
    let legacy = 0, linked = 0, repricingDisagrees = 0
    for (let index = 0; index < cases; index++) {
      const { label, document } = generate(r, index)
      expectParity(document, label)
      if (document.calculationVersion === "legacy_per_line") {
        legacy++
        // A v2 repricing of the same inputs is a different number for some of them: this is what the
        // stored amounts guard against.
        const repriced = buildDraftView({ ...draftViewInputFromRows("invoice", document), calculationVersion: "v2", lines: draftViewInputFromRows("invoice", document).lines.map(({ stored: _stored, ...line }) => line) })
        if (repriced.totals?.tax !== buildDraftView(draftViewInputFromRows("invoice", document)).totals?.tax) repricingDisagrees++
      }
      if (document.items.some((l) => l.deliverableId)) linked++
    }
    expect(legacy).toBeGreaterThan(50)
    expect(linked).toBeGreaterThan(100)
    expect(repricingDisagrees).toBeGreaterThan(0)
  })
})
