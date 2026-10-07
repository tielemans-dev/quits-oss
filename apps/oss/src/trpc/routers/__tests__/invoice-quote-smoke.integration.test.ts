import "dotenv/config"
import { describe, expect, it } from "vitest"
import {
  DK_SCENARIO,
  EU_BASELINE_SCENARIO,
  PRICES_INCLUDE_TAX_SCENARIO,
  US_SCENARIO,
} from "./fixtures/invoice-quote-smoke-fixtures"

const hasDatabaseUrl = Boolean(process.env.DATABASE_URL)
const describeIfDatabase = hasDatabaseUrl ? describe : describe.skip

describeIfDatabase("invoice/quote smoke integration", () => {
  it("runs DK create/edit/send/convert flow with compliance gate", async () => {
    const { runInvoiceQuoteSmokeFlow } = await import("./invoice-quote-smoke")

    const result = await runInvoiceQuoteSmokeFlow(DK_SCENARIO.options)

    expect(result.quote.sendBlockedWithoutTaxId).toBe(DK_SCENARIO.expectsComplianceBlock)
    expect(result.quote.sendBlockedMessage).toContain("MISSING_SELLER_TAX_ID")
    expect(result.quote.sentStatus).toBe("sent")
    expect(result.quote.updatedTotal).toBe(DK_SCENARIO.expectedTotals?.quote)

    expect(result.convertedInvoice.sentStatus).toBe("sent")
    expect(result.convertedInvoice.updatedTotal).toBe(
      DK_SCENARIO.expectedTotals?.convertedInvoice
    )

    expect(result.directInvoice.sentStatus).toBe("sent")
    expect(result.directInvoice.updatedTotal).toBe(DK_SCENARIO.expectedTotals?.directInvoice)
  })

  it("runs US flow without requiring seller tax ID", async () => {
    const { runInvoiceQuoteSmokeFlow } = await import("./invoice-quote-smoke")

    const result = await runInvoiceQuoteSmokeFlow(US_SCENARIO.options)

    expect(result.quote.sendBlockedWithoutTaxId).toBe(US_SCENARIO.expectsComplianceBlock)
    expect(result.quote.sentStatus).toBe("sent")
    expect(result.convertedInvoice.sentStatus).toBe("sent")
    expect(result.directInvoice.sentStatus).toBe("sent")
  })

  it("runs EU-baseline flow and enforces VAT seller tax ID", async () => {
    const { runInvoiceQuoteSmokeFlow } = await import("./invoice-quote-smoke")

    const result = await runInvoiceQuoteSmokeFlow(EU_BASELINE_SCENARIO.options)

    expect(result.quote.sendBlockedWithoutTaxId).toBe(
      EU_BASELINE_SCENARIO.expectsComplianceBlock
    )
    expect(result.quote.sendBlockedMessage).toContain("MISSING_SELLER_TAX_ID")
    expect(result.quote.sentStatus).toBe("sent")
  })

  it("recalculates totals correctly when prices include tax", async () => {
    const { runInvoiceQuoteSmokeFlow } = await import("./invoice-quote-smoke")

    const result = await runInvoiceQuoteSmokeFlow(PRICES_INCLUDE_TAX_SCENARIO.options)

    expect(result.quote.updatedTotal).toBe(PRICES_INCLUDE_TAX_SCENARIO.expectedTotals?.quote)
    expect(result.convertedInvoice.updatedTotal).toBe(
      PRICES_INCLUDE_TAX_SCENARIO.expectedTotals?.convertedInvoice
    )
    expect(result.directInvoice.updatedTotal).toBe(
      PRICES_INCLUDE_TAX_SCENARIO.expectedTotals?.directInvoice
    )
  })
})
