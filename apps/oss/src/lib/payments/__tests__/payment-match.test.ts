import { describe, expect, it } from "vitest"

import { matchPayment, parseAmountMinor, parsePaymentRequest, TOLERANCE_MINOR, toMinor, type MatchInvoice } from "../payment-match"

const invoice = (id: string, name: string, balanceDue: number, extra: Partial<MatchInvoice> = {}): MatchInvoice => ({
  id, number: `F-${id}`, status: "sent", paymentStatus: "unpaid", balanceDue, currency: "DKK", contact: { name }, ...extra,
})
const payment = (amountMinor: number, payer = "", reference = "") => ({ payer, amountMinor, currency: "DKK", reference })

describe("amounts", () => {
  it("reads Danish amounts as whole øre", () => {
    expect(parseAmountMinor("1.250,50")).toBe(125050)
    expect(parseAmountMinor("1250")).toBe(125000)
    expect(parseAmountMinor("0,5")).toBe(50)
    expect(parseAmountMinor("12,345")).toBeNull()
    expect(parseAmountMinor("1,250.50")).toBeNull()
  })

  it("turns server amounts into the exact øre, whatever the float representation", () => {
    expect(toMinor(1250.5, "DKK")).toBe(125050)
    expect(toMinor(0.1 + 0.2, "DKK")).toBe(30)
    expect(toMinor(1250, "JPY")).toBe(1250)
  })
})

describe("matchPayment", () => {
  const open = [invoice("1042", "Havbrise Logistik A/S", 1250.5), invoice("1043", "Nordlys ApS", 1250.5), invoice("1044", "Havbrise Logistik A/S", 800)]

  it("gives one card for an exact amount with the invoice number in the reference", () => {
    const match = matchPayment(payment(125050, "J. Hansen", "Faktura F-1043 tak"), open)
    expect(match.kind === "exact" && match.candidate.invoice.id).toBe("1043")
    expect(matchPayment(payment(125050, "", "F1043"), open).kind).toBe("exact")
  })

  it("does not read part of a number as the number", () => {
    expect(matchPayment(payment(125050, "", "F-10430"), open).kind).toBe("none")
  })

  it("never picks for the person when the amount alone, or the name alone, would have to decide", () => {
    const byAmount = matchPayment(payment(125050), open)
    expect(byAmount.kind).toBe("none")
    const byName = matchPayment(payment(125050, "Havbrise Logistik"), open)
    expect(byName.kind === "shortlist" && byName.candidates.map(c => c.invoice.id)).toEqual(["1042"])
  })

  it("ranks invoices within the tolerance by reference, then name, then how little is short", () => {
    const list = [invoice("a", "Havbrise Logistik A/S", 1000), invoice("b", "Havbrise Logistik ApS", 1000 + TOLERANCE_MINOR / 100), invoice("c", "Havbrise Transport", 1000)]
    const match = matchPayment(payment(100000, "Havbrise Logistik"), list)
    expect(match.kind === "shortlist" && match.candidates.map(c => [c.invoice.id, c.shortMinor])).toEqual([["a", 0], ["b", TOLERANCE_MINOR], ["c", 0]])
  })

  it("does not offer an invoice the transfer overpays, or one short by more than the tolerance", () => {
    expect(matchPayment(payment(100001, "Havbrise Logistik"), [invoice("a", "Havbrise Logistik", 1000)]).kind).toBe("none")
    expect(matchPayment(payment(100000 - TOLERANCE_MINOR - 1, "Havbrise Logistik"), [invoice("a", "Havbrise Logistik", 1000)]).kind).toBe("none")
  })

  it("skips drafts, paid and credited invoices and other currencies", () => {
    const skipped = [
      invoice("d", "Havbrise", 100, { status: "draft" }), invoice("p", "Havbrise", 100, { paymentStatus: "paid" }),
      invoice("c", "Havbrise", 100, { status: "credited" }), invoice("e", "Havbrise", 100, { currency: "EUR" }),
    ]
    expect(matchPayment(payment(10000, "Havbrise", "F-d F-p F-c F-e"), skipped).kind).toBe("none")
  })

  it("offers two invoices that both fit exactly as a shortlist, not a pick", () => {
    const twins = [invoice("1", "Nordlys ApS", 500), invoice("2", "Nordlys ApS", 500)]
    expect(matchPayment(payment(50000, "Nordlys", "F-1 F-2"), twins).kind).toBe("shortlist")
  })
})

describe("parsePaymentRequest", () => {
  it("reads payer, amount and reference", () => {
    expect(parsePaymentRequest("betaling modtaget fra Havbrise Logistik 1.250,50 kr ref faktura F-1042")).toEqual({
      payer: "Havbrise Logistik", amountMinor: 125050, currency: "DKK", reference: "faktura F-1042",
    })
    expect(parsePaymentRequest("Betaling 500 kr.")).toEqual({ payer: "", amountMinor: 50000, currency: "DKK", reference: "" })
  })

  it("leaves everything else to search", () => {
    for (const input of ["betaling", "betaling nordlys", "betaling 0 kr", "faktura til nordlys", "vis forfaldne"]) expect(parsePaymentRequest(input)).toBeNull()
  })
})
