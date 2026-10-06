import { describe, expect, it } from "vitest"
import {
  ACCOUNTING_EXPORT_COLUMNS,
  accountingExportInputSchema,
  einvoiceExportResultSchema,
  isPeppolEasCode,
  PEPPOL_EAS_CODES,
  peppolEndpointIssue,
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

  it("knows the Peppol EAS code list", () => {
    expect(PEPPOL_EAS_CODES).toHaveLength(83)
    expect(isPeppolEasCode("0184")).toBe(true)
    expect(isPeppolEasCode("9930")).toBe(true)
    expect(isPeppolEasCode("1234")).toBe(false)
    expect(isPeppolEasCode("9999")).toBe(false)
    expect(isPeppolEasCode("GLN")).toBe(false)
  })

  it("validates Peppol endpoints per scheme (BR-CL-25)", () => {
    expect(peppolEndpointIssue("0184", "12345678")).toBeNull()
    expect(peppolEndpointIssue("0184", "1234")).toBe("id")
    expect(peppolEndpointIssue("0184", "DK12345678")).toBe("id")
    expect(peppolEndpointIssue("0088", "5790000000005")).toBeNull()
    expect(peppolEndpointIssue("0088", "4000001000005")).toBeNull()
    expect(peppolEndpointIssue("0088", "5790000000001")).toBe("id")
    expect(peppolEndpointIssue("0088", "579000000000")).toBe("id")
    expect(peppolEndpointIssue("9930", "DE123456789")).toBeNull()
    expect(peppolEndpointIssue("9930", "de123456789")).toBeNull()
    expect(peppolEndpointIssue("9930", "123456789")).toBe("id")
    expect(peppolEndpointIssue("9944", "NL123456789B01")).toBeNull()
    expect(peppolEndpointIssue("9944", "DE123456789")).toBe("id")
    expect(peppolEndpointIssue("0192", "123456789")).toBeNull()
    expect(peppolEndpointIssue("0007", "5560000000")).toBeNull()
    expect(peppolEndpointIssue("0208", "0123456789")).toBeNull()
    expect(peppolEndpointIssue("0208", "BE0123456789")).toBe("id")
    expect(peppolEndpointIssue("0060", "123456789")).toBeNull()
    expect(peppolEndpointIssue("0211", "IT12345678901")).toBeNull()
    expect(peppolEndpointIssue("9906", "anything")).toBe("scheme")
    expect(peppolEndpointIssue("1234", "anything")).toBe("scheme")
    expect(peppolEndpointIssue("0204", "991-12345-67")).toBeNull()
    expect(peppolEndpointIssue("0204", "with space")).toBe("id")
    expect(peppolEndpointIssue("0204", "")).toBe("id")
  })
})
