import Decimal from "decimal.js-light"
import { describe, expect, it } from "vitest"
import { documentViewSchema } from "@quits/contracts/document-view"
import type { DocumentView } from "@quits/contracts/document-view"
import { calculateDraft } from "../pricing"
import {
  buildDraftView, buildIssuedView, formatDocumentNumber,
  type DraftViewInput, type DraftViewLineInput, type IssuedMoneySnapshot,
} from "./view"

const standard = { treatment: "standard" as const, rate: "0.25", country: "DK" }
const exempt = { treatment: "exempt" as const, rate: "0", reasonCode: "financial" as const }
const reverse = { treatment: "intra_community" as const, rate: "0", reasonCode: "services_b2b" as const, country: "DE" }
const evidence = { buyerVatId: "DE123456789", viesCheck: { at: "2026-10-07T12:00:00.000Z", result: "valid" as const }, statementText: "Reverse charge" }

const line = (unitPrice: string | number, extra: Partial<DraftViewLineInput> = {}): DraftViewLineInput =>
  ({ description: "Work", quantity: "1", unitPrice, ...extra })
const draft = (lines: DraftViewLineInput[], extra: Partial<DraftViewInput> = {}): DraftViewInput => ({
  kind: "invoice", status: "draft", locale: "da-DK", timezone: "Europe/Copenhagen",
  currency: "DKK", pricesIncludeTax: false, taxRate: "25", lines, ...extra,
})
const sum = (values: Array<string | null>) => values.reduce((total, value) => total.plus(value!), new Decimal(0))

/** What calculateDraft says for the same lines, to compare the view against. */
function expected(input: DraftViewInput) {
  return calculateDraft({
    items: input.lines.map((l) => ({ description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, ...(l.vat ? { vat: l.vat } : {}) })),
    taxRate: input.taxRate, currency: input.currency, pricesIncludeTax: input.pricesIncludeTax,
    ...(input.vatEvidence ? { vatEvidence: input.vatEvidence } : {}),
  })
}

function expectMatchesEngine(input: DraftViewInput) {
  const view = buildDraftView(input), engine = expected(input)
  expect(view.totals).toEqual({ net: engine.net, tax: engine.tax, gross: engine.gross, payableRounding: engine.payableRounding, payable: engine.payableGross })
  expect(view.lines.map(({ net, tax, gross }) => ({ net, tax, gross }))).toEqual(engine.lines.map(({ net, tax, gross }) => ({ net, tax, gross })))
  expect(view.vatGroups).toEqual(engine.groups.map((g) => ({
    key: g.key, treatment: g.treatment, rate: g.rate, reasonCode: g.reasonCode, country: g.country,
    net: g.net, tax: g.tax, gross: g.gross, payableRounding: g.payableRounding,
  })))
  // The printed column adds up to the document.
  const amounts = sum(view.lines.map((l) => l.amount))
  expect(amounts.toFixed(view.exponent)).toBe(input.pricesIncludeTax ? view.totals!.gross : view.totals!.net)
  expect(view.lines.map((l) => l.amount)).toEqual(view.lines.map((l) => input.pricesIncludeTax ? l.gross : l.net))
  expect(documentViewSchema.parse(view)).toEqual(view)
  return view
}

const mixed = [
  line("100.50", { quantity: "3" }),
  line("40", { description: "Training", vat: exempt }),
  line("1999.99", { description: "Consulting", vat: reverse }),
  line("0.01", { vat: standard }),
  line("12.345", { quantity: "0.5" }),
]

describe("buildDraftView", () => {
  for (const pricesIncludeTax of [false, true]) {
    it(`equals calculateDraft for mixed VAT (pricesIncludeTax: ${pricesIncludeTax})`, () => {
      const view = expectMatchesEngine(draft(mixed, { pricesIncludeTax, vatEvidence: evidence }))
      // The standard lines with a country and the ones without are different groups.
      expect([...new Set(view.vatGroups.map((g) => g.treatment))].sort()).toEqual(["exempt", "intra_community", "standard"])
      // The exemption and reverse-charge text is printed from these.
      expect(view.vatGroups.find((g) => g.treatment === "exempt")).toMatchObject({ reasonCode: "financial", country: null })
      expect(view.vatGroups.find((g) => g.treatment === "intra_community")).toMatchObject({ reasonCode: "services_b2b", country: "DE" })
      expect(view.vatEvidence).toEqual(evidence)
    })
  }

  it("keeps a group's payable rounding as stored, apart from net and tax", () => {
    const lines = [line("0.01"), line("0.01")]
    const view = expectMatchesEngine(draft(lines, { pricesIncludeTax: true }))
    expect(view.vatGroups[0]).toMatchObject({ net: "0.02", tax: "0.01", gross: "0.02", payableRounding: "-0.01" })
    expect(view.totals).toMatchObject({ net: "0.02", tax: "0.01", gross: "0.02", payableRounding: "-0.01", payable: "0.02" })
    const totals = view.totals!
    expect(new Decimal(totals.net).plus(totals.tax).plus(totals.payableRounding).toFixed(2)).toBe(totals.gross)
  })

  it("prints the amount on the document's price basis", () => {
    const [exclusive] = buildDraftView(draft([line("100")])).lines
    expect(exclusive).toMatchObject({ unitPrice: "100", net: "100.00", tax: "25.00", gross: "125.00", amount: "100.00" })
    const [inclusive] = buildDraftView(draft([line("125")], { pricesIncludeTax: true })).lines
    expect(inclusive).toMatchObject({ unitPrice: "125", net: "100.00", tax: "25.00", gross: "125.00", amount: "125.00" })
  })

  it("formats money at the currency's exponent", () => {
    const jpy = expectMatchesEngine(draft([line("1000"), line("333", { quantity: "3" })], { currency: "JPY" }))
    expect(jpy.exponent).toBe(0)
    expect(jpy.totals).toEqual({ net: "1999", tax: "500", gross: "2499", payableRounding: "0", payable: "2499" })
    expectMatchesEngine(draft([line("1000"), line("333", { quantity: "3" })], { currency: "JPY", pricesIncludeTax: true }))
    for (const currency of ["DKK", "EUR"]) {
      const view = expectMatchesEngine(draft(mixed, { currency }))
      expect(view.exponent).toBe(2)
      expect(view.totals!.net).toMatch(/\.\d{2}$/)
    }
  })

  it("keeps the line key stable: the id, else the client key", () => {
    const view = buildDraftView(draft([line("1", { id: "item-1", clientKey: "k1" }), line("2", { clientKey: "k2" })]))
    expect(view.lines.map(({ key, id }) => ({ key, id }))).toEqual([{ key: "item-1", id: "item-1" }, { key: "k2", id: null }])
  })

  describe("input that cannot be calculated", () => {
    const cases: Array<[string, DraftViewLineInput[], Partial<DraftViewInput>?]> = [
      ["an empty price", [line("100"), line("")]],
      ["a decimal comma", [line("1,5")]],
      ["a quantity with a decimal comma", [line("10", { quantity: "1,5" })]],
      ["too many decimals", [line("1.12345")]],
      ["too many quantity decimals", [line("1", { quantity: "1.1234567" })]],
      ["a non-finite number", [line(Number.NaN)]],
      ["an unreadable document tax rate", [line("1")], { taxRate: "abc" }],
      ["out-of-scope mixed with standard", [line("1", { vat: standard }), line("2", { vat: { treatment: "out_of_scope" } })]],
    ]
    for (const [name, lines, extra] of cases) {
      it(`gives null totals and no amounts for ${name}`, () => {
        const view = buildDraftView(draft(lines, extra))
        expect(view.totals).toBeNull()
        expect(view.vatGroups).toEqual([])
        for (const l of view.lines) expect(l).toMatchObject({ net: null, tax: null, gross: null, amount: null, locked: false })
        expect(view.lines).toHaveLength(lines.length)
        expect(documentViewSchema.parse(view)).toEqual(view)
      })
    }

    it("keeps what was typed", () => {
      const [first] = buildDraftView(draft([line("1,5", { quantity: "2" })])).lines
      expect(first).toMatchObject({ quantity: "2", unitPrice: "1,5" })
    })

    it("never throws on a half-typed document", () => {
      expect(() => buildDraftView(draft([], { dates: { dueDate: "2026-1", issueDate: "" } }))).not.toThrow()
      expect(buildDraftView(draft([], { dates: { dueDate: "2026-1", issueDate: "" } })).dates.dueDate).toBeNull()
    })
  })

  it("has zero totals for a draft without lines", () => {
    expect(buildDraftView(draft([])).totals).toEqual({ net: "0.00", tax: "0.00", gross: "0.00", payableRounding: "0.00", payable: "0.00" })
  })

  it("refuses a currency whose precision is unsupported", () => {
    expect(() => buildDraftView(draft([line("1")], { currency: "KWD" }))).toThrow(/currency precision/i)
  })

  describe("agreement-linked frozen lines", () => {
    const frozen = (net: string, tax: string, gross: string, extra: Partial<DraftViewLineInput> = {}): DraftViewLineInput =>
      ({ id: "linked", description: "Milestone", quantity: "1", unitPrice: net, vat: { treatment: "standard", rate: "0.25" }, frozen: { net, tax, gross }, ...extra })

    it("keeps their stored amounts, locked, and adds them exactly", () => {
      // 0.1 + 0.2 and friends: float addition gives 0.30000000000000004.
      const linked = [frozen("0.10", "0.03", "0.13", { id: "a" }), frozen("0.20", "0.05", "0.25", { id: "b" })]
      const view = buildDraftView(draft([...linked, line("0.10", { clientKey: "c" })]))
      expect(view.lines.map((l) => l.locked)).toEqual([true, true, false])
      expect(view.lines[0]).toMatchObject({ net: "0.10", tax: "0.03", gross: "0.13", amount: "0.10" })
      expect(0.1 + 0.2).not.toBe(0.3)
      expect(view.totals).toMatchObject({ net: "0.40", tax: "0.11", gross: "0.51", payableRounding: "0.00", payable: "0.51" })
      expect(sum(view.lines.map((l) => l.amount)).toFixed(2)).toBe(view.totals!.net)
      expect(documentViewSchema.parse(view)).toEqual(view)
    })

    it("equals the calculated total when no line is frozen, and adds frozen lines to it exactly", () => {
      const calculated = [line("100.50", { quantity: "3" }), line("40", { vat: exempt })]
      const alone = buildDraftView(draft(calculated)).totals!
      const view = buildDraftView(draft([...calculated, frozen("0.10", "0.03", "0.13")]))
      expect(view.totals).toEqual({
        net: new Decimal(alone.net).plus("0.10").toFixed(2), tax: new Decimal(alone.tax).plus("0.03").toFixed(2),
        gross: new Decimal(alone.gross).plus("0.13").toFixed(2), payableRounding: "0.00",
        payable: new Decimal(alone.payable).plus("0.13").toFixed(2),
      })
      // The frozen line joins the standard group; the others are untouched.
      expect(view.vatGroups.map((g) => g.treatment).sort()).toEqual(["exempt", "standard"])
      const group = view.vatGroups.find((g) => g.treatment === "standard")!
      expect(group.net).toBe(new Decimal(buildDraftView(draft(calculated)).vatGroups.find((g) => g.treatment === "standard")!.net).plus("0.10").toFixed(2))
    })

    it("carries a frozen line's own rounding on tax-inclusive documents", () => {
      const view = buildDraftView(draft([frozen("0.01", "0.01", "0.01")], { pricesIncludeTax: true }))
      expect(view.lines[0]).toMatchObject({ gross: "0.01", amount: "0.01", locked: true })
      expect(view.totals).toMatchObject({ net: "0.01", tax: "0.01", gross: "0.01", payableRounding: "-0.01", payable: "0.01" })
      expect(view.vatGroups[0]!.payableRounding).toBe("-0.01")
    })

    it("opens a group of its own for a classification the calculated lines do not use", () => {
      const view = buildDraftView(draft([line("10"), frozen("5.00", "0.00", "5.00", { vat: exempt })]))
      expect(view.vatGroups.map((g) => g.treatment).sort()).toEqual(["exempt", "standard"])
      expect(view.vatGroups.find((g) => g.treatment === "exempt")).toMatchObject({ reasonCode: "financial", net: "5.00" })
    })

    it("sums frozen lines on their own", () => {
      const view = buildDraftView(draft([frozen("0.10", "0.03", "0.13", { id: "a" }), frozen("0.20", "0.05", "0.25", { id: "b" })]))
      expect(view.totals).toMatchObject({ net: "0.30", tax: "0.08", gross: "0.38" })
    })

    it("adds amounts a float cannot hold", () => {
      const big = "9007199254740993.01"
      expect(String(Number(big) + 0.02)).not.toBe("9007199254740993.03")
      const view = buildDraftView(draft([frozen(big, "0.00", big, { id: "a" }), frozen("0.02", "0.00", "0.02", { id: "b" })]))
      expect(view.totals).toMatchObject({ net: "9007199254740993.03", gross: "9007199254740993.03", payable: "9007199254740993.03" })
    })

    it("formats frozen amounts stored with two decimals at a zero-decimal currency", () => {
      const view = buildDraftView(draft([frozen("100.00", "25.00", "125.00")], { currency: "JPY" }))
      expect(view.lines[0]).toMatchObject({ net: "100", tax: "25", gross: "125" })
      expect(view.totals).toMatchObject({ net: "100", tax: "25", gross: "125", payable: "125" })
    })

    it("keeps a locked line's amounts when the rest of the draft cannot be calculated", () => {
      const view = buildDraftView(draft([frozen("0.10", "0.03", "0.13"), line("")]))
      expect(view.totals).toBeNull()
      expect(view.lines[0]).toMatchObject({ net: "0.10", amount: "0.10", locked: true })
      expect(view.lines[1]).toMatchObject({ net: null, amount: null, locked: false })
    })

    const unreadable: Array<[string, DraftViewLineInput]> = [
      ["an amount beyond the currency's precision", frozen("0.101", "0.03", "0.13")],
      ["a comma amount", frozen("0,10", "0.03", "0.13")],
      ["a missing classification", frozen("0.10", "0.03", "0.13", { vat: undefined })],
      ["a missing rate", frozen("0.10", "0.03", "0.13", { vat: { treatment: "standard" } })],
      ["a rate that disagrees with its treatment", frozen("0.10", "0.00", "0.10", { vat: { treatment: "standard", rate: "0" } })],
    ]
    for (const [name, linked] of unreadable) {
      it(`does not guess for ${name}`, () => {
        const view = buildDraftView(draft([line("1"), linked]))
        expect(view.totals).toBeNull()
        expect(view.vatGroups).toEqual([])
        expect(view.lines[1]).toMatchObject({ net: null, amount: null, locked: true })
      })
    }

    it("refuses to mix a frozen out-of-scope line with a standard one", () => {
      const view = buildDraftView(draft([line("1"), frozen("5.00", "0.00", "5.00", { vat: { treatment: "out_of_scope", rate: "0" } })]))
      expect(view.totals).toBeNull()
    })
  })

  it("carries the document around its lines", () => {
    const view = buildDraftView(draft([line("100")], {
      status: "draft", number: null, previewNumber: "INV-0043", contactId: "contact-1", notes: "  ", logoUrl: "https://logo.test/a.png",
      dates: { dueDate: "2026-11-07", supplyDate: "2026-10-07", issueDate: null },
      seller: {
        companyName: "Acme ApS", companyEmail: "a@acme.test", companyAddress: "Vej 1", taxIds: [{ scheme: "VAT", value: "DK12345678", countryCode: "DK" }],
        bankAccount: { iban: "DK5000400440116243", bic: "DABADKKK" }, paymentNote: "MobilePay 12345",
      },
      buyer: { name: "Kunde", country: "DK", taxIds: [] },
    }))
    expect(view).toMatchObject({
      kind: "invoice", state: "draft", number: { value: null, preview: "INV-0043" },
      seller: { name: "Acme ApS", email: "a@acme.test", address: "Vej 1", logoUrl: "https://logo.test/a.png", taxIds: [{ scheme: "VAT", value: "DK12345678", countryCode: "DK" }] },
      buyer: { name: "Kunde", email: null, country: "DK", contactId: "contact-1" },
      dates: { issueDate: null, supplyDate: "2026-10-07", dueDate: "2026-11-07", expiryDate: null },
      notes: null, calculation: { version: "v2", staleLegacy: false },
      // A draft without a number has no reference to print, unless it sets its own.
      paymentDetails: { bankAccount: { iban: "DK5000400440116243", bic: "DABADKKK", accountHolder: null }, note: "MobilePay 12345", reference: null },
    })
    expect(documentViewSchema.parse(view)).toEqual(view)
  })

  it("drops the preview once a draft already has its number, and uses it as the payment reference", () => {
    const seller = { bankAccount: { iban: "DK5000400440116243" } }
    const numbered = buildDraftView(draft([line("1")], { number: "INV-0007", previewNumber: "INV-0043", seller }))
    expect(numbered.number).toEqual({ value: "INV-0007", preview: null })
    expect(numbered.paymentDetails?.reference).toBe("INV-0007")
    expect(buildDraftView(draft([line("1")], { number: "INV-0007", paymentReference: "  ref 9 ", seller })).paymentDetails?.reference).toBe("ref 9")
  })

  it("has no payment details without an account or a note, and says a legacy draft is stale", () => {
    const view = buildDraftView(draft([line("1")], { staleLegacy: true, seller: { bankAccount: { iban: " " }, paymentNote: " " } }))
    expect(view.paymentDetails).toBeNull()
    expect(view.calculation).toEqual({ version: "v2", staleLegacy: true })
  })

  it("accepts a quote with an expiry date and no buyer yet", () => {
    const view = buildDraftView(draft([line("1")], { kind: "quote", dates: { expiryDate: "2026-12-01" } }))
    expect(view).toMatchObject({ kind: "quote", buyer: null, dates: { expiryDate: "2026-12-01" } })
  })
})

describe("buildIssuedView", () => {
  const snapshot = (): IssuedMoneySnapshot => ({
    number: "INV-0042", issueDate: "2026-10-07", supplyDate: "2026-10-05", dueDate: "2026-11-07", currency: "DKK", exponent: 2,
    // Not what repricing 3 × 33.33 at 25 % would give: the snapshot is what was issued.
    lines: [
      { lineId: "l1", description: "Work", quantityInput: "3", unitPriceInput: "33.33", net: "99.98", tax: "25.00", gross: "124.99", vat: { treatment: "standard", rate: "0.25", reasonCode: null, country: "DK" } },
      { lineId: "l2", description: "Fee", quantityInput: "1", unitPriceInput: "10", net: "10.00", tax: "0.00", gross: "10.00", vat: { treatment: "exempt", rate: "0", reasonCode: "financial", country: null } },
    ],
    vatGroups: [
      { key: "std", treatment: "standard", rate: "0.25", reasonCode: null, country: "DK", net: "99.98", tax: "25.00", gross: "124.99", payableRounding: "0.01", evidence },
      { key: "ex", treatment: "exempt", rate: "0", reasonCode: "financial", country: null, net: "10.00", tax: "0.00", gross: "10.00", payableRounding: "0.00", evidence },
    ],
    totals: { net: "109.98", tax: "25.00", gross: "134.99", payableRounding: "0.01" },
    calculation: { version: "v2", pricesIncludeTax: true },
    seller: { companyName: "Acme ApS", taxIds: [{ scheme: "VAT", value: "DK12345678" }], bankAccount: { iban: "DK5000400440116243" } },
    buyer: { name: "Kunde", country: "DK" },
  })
  const extras = { kind: "invoice" as const, status: "sent", locale: "da-DK", timezone: "Europe/Copenhagen" }

  it("copies the snapshot's amounts unchanged, even when repricing would differ", () => {
    const s = snapshot()
    const repriced = calculateDraft({ items: [{ description: "Work", quantity: "3", unitPrice: "33.33", vat: { treatment: "standard", rate: "0.25" } }], taxRate: "25", currency: "DKK", pricesIncludeTax: true })
    expect(repriced.lines[0]!.gross).not.toBe(s.lines[0]!.gross)

    const view = buildIssuedView(s, extras)
    expect(view.lines.map(({ net, tax, gross }) => ({ net, tax, gross }))).toEqual(s.lines.map(({ net, tax, gross }) => ({ net, tax, gross })))
    expect(view.lines.map((l) => l.amount)).toEqual(["124.99", "10.00"])
    expect(view.vatGroups.map(({ key, net, tax, gross, payableRounding }) => ({ key, net, tax, gross, payableRounding })))
      .toEqual(s.vatGroups.map(({ key, net, tax, gross, payableRounding }) => ({ key, net, tax, gross, payableRounding })))
    expect(view.totals).toEqual({ net: "109.98", tax: "25.00", gross: "134.99", payableRounding: "0.01", payable: "134.99" })
    expect(view).toMatchObject({
      state: "issued", status: "sent", number: { value: "INV-0042", preview: null }, currency: "DKK", exponent: 2, pricesIncludeTax: true,
      dates: { issueDate: "2026-10-07", supplyDate: "2026-10-05", dueDate: "2026-11-07", expiryDate: null },
      calculation: { version: "v2", staleLegacy: false },
    })
    expect(view.lines.every((l) => l.locked && l.key === l.id)).toBe(true)
    expect(documentViewSchema.parse(view)).toEqual(view)
  })

  it("takes the amount column from the net on a tax-exclusive document", () => {
    const s = snapshot()
    s.calculation.pricesIncludeTax = false
    expect(buildIssuedView(s, extras).lines.map((l) => l.amount)).toEqual(["99.98", "10.00"])
  })

  it("keeps the exemption reasons and evidence of the issued groups", () => {
    const view = buildIssuedView(snapshot(), extras)
    expect(view.vatGroups[1]).toMatchObject({ treatment: "exempt", reasonCode: "financial" })
    expect(view.vatEvidence).toEqual(evidence)
    expect(buildIssuedView(snapshot(), { ...extras, vatEvidence: null }).vatEvidence).toBeNull()
    const s = snapshot()
    const disagreeing = { ...s, vatGroups: [s.vatGroups[0]!, { ...s.vatGroups[1]!, evidence: { statementText: "Other" } }] }
    expect(buildIssuedView(disagreeing, extras).vatEvidence).toBeNull()
  })

  it("prints the number as the payment reference unless the invoice has its own", () => {
    expect(buildIssuedView(snapshot(), extras).paymentDetails).toEqual({
      bankAccount: { iban: "DK5000400440116243", accountHolder: null, bankName: null, regNumber: null, accountNumber: null, bic: null },
      note: null, reference: "INV-0042",
    })
    expect(buildIssuedView(snapshot(), { ...extras, paymentReference: " +71 123 " }).paymentDetails?.reference).toBe("+71 123")
  })

  it("builds a credit note from the same snapshot, without payment details or a due date", () => {
    const { dueDate: _dueDate, ...credit } = snapshot()
    const view = buildIssuedView(credit, { ...extras, kind: "creditNote", status: "issued" })
    expect(view).toMatchObject({ kind: "creditNote", paymentDetails: null, dates: { dueDate: null } })
    expect(view.totals?.gross).toBe("134.99")
  })

  it("carries a legacy calculation's version and the contact", () => {
    const s = snapshot()
    s.calculation.version = "legacy_per_line"
    const view = buildIssuedView(s, { ...extras, contactId: "contact-1", logoUrl: "https://logo.test/a.png", notes: "Thanks", expiryDate: null })
    expect(view).toMatchObject({ calculation: { version: "legacy_per_line", staleLegacy: false }, buyer: { contactId: "contact-1" }, notes: "Thanks", seller: { logoUrl: "https://logo.test/a.png" } })
  })
})

describe("the contract", () => {
  const view = (): DocumentView => buildDraftView(draft(mixed, { buyer: { name: "Kunde" }, contactId: "c1", vatEvidence: evidence }))

  it("round-trips", () => {
    expect(documentViewSchema.parse(JSON.parse(JSON.stringify(view())))).toEqual(view())
  })

  it("rejects unknown keys at every level", () => {
    const withKey = (mutate: (v: Record<string, any>) => void) => {
      const copy = structuredClone(view()) as Record<string, any>
      mutate(copy)
      return documentViewSchema.safeParse(copy).success
    }
    expect(withKey(() => {})).toBe(true)
    expect(withKey((v) => { v.extra = 1 })).toBe(false)
    expect(withKey((v) => { v.number.extra = 1 })).toBe(false)
    expect(withKey((v) => { v.seller.extra = 1 })).toBe(false)
    expect(withKey((v) => { v.buyer.extra = 1 })).toBe(false)
    expect(withKey((v) => { v.dates.extra = 1 })).toBe(false)
    expect(withKey((v) => { v.lines[0].extra = 1 })).toBe(false)
    expect(withKey((v) => { v.lines[0].vat.extra = 1 })).toBe(false)
    expect(withKey((v) => { v.vatGroups[0].extra = 1 })).toBe(false)
    expect(withKey((v) => { v.totals.extra = 1 })).toBe(false)
    expect(withKey((v) => { v.calculation.extra = 1 })).toBe(false)
  })
})

describe("formatDocumentNumber", () => {
  it("pads the counter to four digits", () => {
    expect(formatDocumentNumber("INV", 1)).toBe("INV-0001")
    expect(formatDocumentNumber("QTE", 42)).toBe("QTE-0042")
    expect(formatDocumentNumber("CN", 12345)).toBe("CN-12345")
  })
})
