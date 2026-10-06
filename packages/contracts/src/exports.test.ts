import { describe, expect, it } from "vitest"
import {
  ACCOUNTING_EXPORT_COLUMNS,
  accountingExportInputSchema,
  einvoiceExportResultSchema,
  isPeppolEasCode,
  isValidPeppolIdentifier,
  normalizePeppolIdentifier,
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
    expect(peppolEndpointIssue("0192", "123456785")).toBeNull()
    expect(peppolEndpointIssue("0007", "5560360793")).toBeNull()
    expect(peppolEndpointIssue("0208", "0403003425")).toBeNull()
    expect(peppolEndpointIssue("0208", "BE0123456789")).toBe("id")
    expect(peppolEndpointIssue("0060", "123456789")).toBeNull()
    expect(peppolEndpointIssue("0211", "IT12345678903")).toBeNull()
    expect(peppolEndpointIssue("9906", "anything")).toBe("scheme")
    expect(peppolEndpointIssue("1234", "anything")).toBe("scheme")
    expect(peppolEndpointIssue("0204", "991-12345-67")).toBeNull()
    expect(peppolEndpointIssue("0204", "with space")).toBe("id")
    expect(peppolEndpointIssue("0204", "")).toBe("id")
  })

  it("applies the PEPPOL-COMMON identifier rules", () => {
    // R056-1: Dutch VAT numbers are NL + 9 digits + B + 2 digits.
    expect(peppolEndpointIssue("9944", "NL12")).toBe("id")
    expect(peppolEndpointIssue("9944", "NL123456789X01")).toBe("id")
    expect(peppolEndpointIssue("9944", "nl123456789b01")).toBeNull()
    // R041: Norwegian organization numbers carry a mod-11 check digit.
    expect(peppolEndpointIssue("0192", "123456789")).toBe("id")
    expect(peppolEndpointIssue("0192", "974764253")).toBeNull()
    expect(peppolEndpointIssue("0192", "000000000")).toBe("id")
    // R040: GLN check digit.
    expect(peppolEndpointIssue("0088", "5790000000001")).toBe("id")
    // R043: Belgian enterprise number mod-97.
    expect(peppolEndpointIssue("0208", "0123456789")).toBe("id")
    expect(peppolEndpointIssue("0208", "0123456749")).toBeNull()
    // R049: Swedish organisation number Luhn check.
    expect(peppolEndpointIssue("0007", "5560000000")).toBe("id")
    expect(peppolEndpointIssue("0007", "5560000001")).toBeNull()
    // R050: ABN mod-89.
    expect(peppolEndpointIssue("0151", "51824753556")).toBeNull()
    expect(peppolEndpointIssue("0151", "51824753557")).toBe("id")
    // R047: partita IVA check digit.
    expect(peppolEndpointIssue("0211", "IT12345678901")).toBe("id")
    // R052-R055: Danish P/SE numbers, Dutch KvK and OIN formats.
    expect(peppolEndpointIssue("0096", "1234567890")).toBeNull()
    expect(peppolEndpointIssue("0096", "123456789")).toBe("id")
    expect(peppolEndpointIssue("0198", "DK12345678")).toBeNull()
    expect(peppolEndpointIssue("0198", "12345678")).toBe("id")
    expect(peppolEndpointIssue("0106", "1234567")).toBe("id")
    expect(peppolEndpointIssue("0190", "12345678901234567890")).toBeNull()
    expect(peppolEndpointIssue("0190", "1234567890")).toBe("id")
    // R044/R045: Italian IPA code and codice fiscale.
    expect(peppolEndpointIssue("0201", "UFXXXX")).toBeNull()
    expect(peppolEndpointIssue("0201", "UFX-XX")).toBe("id")
    expect(peppolEndpointIssue("0210", "RSSMRA85T10A562S")).toBeNull()
    expect(peppolEndpointIssue("0210", "12345678901")).toBeNull()
    expect(peppolEndpointIssue("0210", "RSSMRA")).toBe("id")
  })

  it("validates the normalized identifier, which is the one to export", () => {
    expect(normalizePeppolIdentifier("9944", " nl123456789b01 ")).toBe("NL123456789B01")
    expect(normalizePeppolIdentifier("0201", " ufxxxx ")).toBe("ufxxxx")
    expect(isValidPeppolIdentifier("9944", "NL123456789B01")).toBe(true)
    // The exact value is checked: an un-normalized identifier is not exportable as-is.
    expect(isValidPeppolIdentifier("9944", "nl123456789b01")).toBe(false)
    expect(isValidPeppolIdentifier("9930", " DE123456789")).toBe(false)
  })
})
