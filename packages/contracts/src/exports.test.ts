import { describe, expect, it } from "vitest"
import {
  ACCOUNTING_EXPORT_COLUMNS,
  accountingExportInputSchema,
  einvoiceExportResultSchema,
} from "./exports"

describe("export contracts", () => {
  it("accepts inclusive date ranges and rejects reversed ones", () => {
    expect(
      accountingExportInputSchema.safeParse({ from: "2026-01-01", to: "2026-01-01", dataset: "payments" }).success
    ).toBe(true)
    expect(
      accountingExportInputSchema.safeParse({ from: "2026-02-01", to: "2026-01-01", dataset: "invoices" }).success
    ).toBe(false)
    expect(
      accountingExportInputSchema.safeParse({ from: "2026-1-1", to: "2026-01-31", dataset: "invoices" }).success
    ).toBe(false)
  })

  it("requires at least one missing field on a failed e-invoice export", () => {
    expect(einvoiceExportResultSchema.safeParse({ ok: false, missing: [] }).success).toBe(false)
    expect(einvoiceExportResultSchema.safeParse({ ok: false, missing: ["buyer.country"] }).success).toBe(true)
  })

  it("keeps the accounting column contracts stable", () => {
    expect(ACCOUNTING_EXPORT_COLUMNS.invoices).toEqual([
      "number",
      "issue_date",
      "due_date",
      "customer",
      "currency",
      "net",
      "tax",
      "gross",
      "paid",
      "credited",
      "balance",
      "status",
    ])
    expect(ACCOUNTING_EXPORT_COLUMNS.creditNotes[0]).toBe("number")
    expect(ACCOUNTING_EXPORT_COLUMNS.payments[0]).toBe("paid_date")
  })
})
