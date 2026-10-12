import { describe, expect, it } from "vitest"
import fixture from "../../events/__tests__/fixtures/invoice.issued.v1.json"
import { issuedInvoiceSettlement, issuedInvoiceTotals } from "../issued-settlement"
import { issuedSeller } from "../issued-invoice"

const issued = {
  ...fixture.cases[0]!.payload,
  totals: { ...fixture.cases[0]!.payload.totals, gross: "2500.00" },
  seller: { bankAccount: { regNumber: "5678", accountNumber: "0123456789" }, paymentNote: "Issue-time note" },
}

describe("issued invoice payment facts", () => {
  it("settles the issued gross against the invoice's own payments and credits", () => {
    const settlement = issuedInvoiceSettlement({
      issuanceSnapshot: issued,
      totalGross: 9999,
      amountPaid: 500,
      amountCredited: 250,
    })
    expect(settlement.totalGross.toNumber()).toBe(2500)
    expect(settlement.balanceDue.toNumber()).toBe(1750)
  })

  it("keeps the stored row total when the issuance snapshot does not parse", () => {
    const settlement = issuedInvoiceSettlement({
      issuanceSnapshot: { seller: { bankAccount: { regNumber: "1234", accountNumber: "9876543" } } },
      totalGross: 1250,
      amountPaid: 0,
      amountCredited: 0,
    })
    expect(settlement.totalGross.toNumber()).toBe(1250)
    expect(settlement.balanceDue.toNumber()).toBe(1250)
  })

  it("does not fill a sparse issued seller from the row snapshot", () => {
    const seller = issuedSeller({ ...fixture.cases[0]!.payload, seller: {} }, {
      bankAccount: { regNumber: "0040", accountNumber: "0440116243" },
      paymentNote: "Legacy frozen note",
    })
    expect(seller?.bankAccount).toBeUndefined()
    expect(seller?.paymentNote).toBeUndefined()
  })

  it("agrees across list, detail and payment instructions when the snapshot differs from the row", () => {
    const row = { issuanceSnapshot: issued, subtotalNet: 8000, totalTax: 1999, totalGross: 9999, amountPaid: 500, amountCredited: 250 }
    const totals = issuedInvoiceTotals(row)
    const settlement = issuedInvoiceSettlement(row)
    expect(totals.total).toBe(2500)
    expect(totals.subtotal).toBe(Number(issued.totals.net))
    expect(totals.taxAmount).toBe(Number(issued.totals.tax))
    expect(settlement.totalGross.toNumber()).toBe(totals.total)
    expect(settlement.balanceDue.toNumber()).toBe(1750)
    expect(issuedInvoiceTotals({ ...row, issuanceSnapshot: null })).toEqual({ subtotal: 8000, taxAmount: 1999, total: 9999 })
  })
})
