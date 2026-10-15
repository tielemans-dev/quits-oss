import { describe, expect, it } from "vitest"
import { postingsFor } from "../postings"
import { creditFixture, invoiceFixture, refusalFixtures } from "./fixtures"
import { TestLedger } from "./ledger"

describe("Phase A pure postings", () => {
  it.each(refusalFixtures)("refuses $name as $code without changing the event", ({ event, code }) => {
    const before = JSON.stringify(event)
    expect(postingsFor(event)).toMatchObject({ code })
    expect(JSON.stringify(event)).toBe(before)
  })
  it("posts calculator-built sale and full credit with exact role and group balances", () => {
    const p = invoiceFixture(), ledger = new TestLedger(), key = p.vatGroups[0]!.key
    ledger.apply({ type: "invoice.issued", schemaVersion: 1, payload: p })
    ledger.assertEnding({ debtor: "125", revenue: "-100", output_vat: "-25" }, { [key]: { revenue: "-100", output_vat: "-25" } })
    ledger.apply({ type: "credit_note.issued", schemaVersion: 2, payload: creditFixture() })
    ledger.assertEnding({}, { [key]: {} })
  })
  it("posts and fully reverses an unclassified-zero invoice using its frozen non-registration", () => {
    const p = invoiceFixture({ lines: [{ quantity: "1", unitPrice: "100", sortOrder: 0, vat: { treatment: "unclassified_zero", rate: "0", country: "DK" } }] })
    p.seller.momsRegistered = false
    const event = { type: "invoice.issued", schemaVersion: 1, payload: p }
    const frozen = JSON.stringify(event)
    const ledger = new TestLedger(), key = p.vatGroups[0]!.key
    const lines = ledger.apply(event)
    expect(lines.some(line => line.role === "output_vat")).toBe(false)
    expect(lines).toContainEqual({ role: "debtor", debitMinor: "10000", creditMinor: "0", currency: "DKK", exponent: 2, vatGroup: null })
    ledger.assertEnding({ debtor: "10000", revenue: "-10000" }, { [key]: { revenue: "-10000" } })
    const creditLines = ledger.apply({ type: "credit_note.issued", schemaVersion: 2, payload: creditFixture(p) })
    expect(creditLines.some(line => line.role === "output_vat")).toBe(false)
    ledger.assertEnding({}, { [key]: {} })
    expect(JSON.stringify(event)).toBe(frozen)
  })
  it.each([true, null, undefined])("refuses unclassified-zero postings with frozen registration %s", momsRegistered => {
    const p = invoiceFixture({ lines: [{ quantity: "1", unitPrice: "100", sortOrder: 0, vat: { treatment: "unclassified_zero", rate: "0" } }] })
    p.seller.momsRegistered = momsRegistered
    expect(postingsFor({ type: "invoice.issued", schemaVersion: 1, payload: p })).toMatchObject({ code: "unsupported_treatment_combination" })
    expect(postingsFor({ type: "credit_note.issued", schemaVersion: 2, payload: creditFixture(p) })).toMatchObject({ code: "unsupported_treatment_combination" })
  })
  it("preserves standard tax postings with a remembered Danish choice when events carry no tax regime", () => {
    const p = invoiceFixture()
    p.seller.momsRegistered = false
    const ledger = new TestLedger(), key = p.vatGroups[0]!.key
    ledger.apply({ type: "invoice.issued", schemaVersion: 1, payload: p })
    ledger.assertEnding({ debtor: "125", revenue: "-100", output_vat: "-25" }, { [key]: { revenue: "-100", output_vat: "-25" } })
    ledger.apply({ type: "credit_note.issued", schemaVersion: 2, payload: creditFixture(p) })
    ledger.assertEnding({}, { [key]: {} })
  })
  it("preserves decimal strings beyond safe integers and ignores reporting-only VAT valuation", () => {
    const p = invoiceFixture({ lines: [{ quantity: "1000000", unitPrice: "1000000000000", sortOrder: 0, vat: { treatment: "standard", rate: "0.25" } }] })
    const event = { type: "invoice.issued", schemaVersion: 1, payload: p }
    const before = postingsFor(event)
    p.vatReporting = { rate: "9.99", rateSource: "user", taxBaseForReturn: "999", taxForReturn: "777" }
    expect(postingsFor(event)).toEqual(before)
    const ledger = new TestLedger(); ledger.apply(event)
    ledger.assertEnding({ debtor: "125000000000000000000", revenue: "-100000000000000000000", output_vat: "-25000000000000000000" }, { [p.vatGroups[0]!.key]: { revenue: "-100000000000000000000", output_vat: "-25000000000000000000" } })
  })
  it.each(["JPY", "DKK"])("supports currency precision for %s", currency => {
    const p = invoiceFixture({ currency, lines: [{ quantity: "1", unitPrice: "10", sortOrder: 0, vat: { treatment: "out_of_scope", rate: "0" } }] })
    const ledger = new TestLedger(); const lines = ledger.apply({ type: "invoice.issued", schemaVersion: 1, payload: p })
    const amount = p.valuation.base.minor!
    expect(lines.some(l => l.role === "output_vat")).toBe(false)
    ledger.assertEnding({ debtor: amount, revenue: `-${amount}` }, { [p.vatGroups[0]!.key]: { revenue: `-${amount}` } })
  })
})
