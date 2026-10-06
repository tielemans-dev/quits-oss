import { ACCOUNTING_EXPORT_COLUMNS } from "@yaip/contracts/exports"
import { describe, expect, it } from "vitest"
import { creditNotesCsv, invoicesCsv, paymentsCsv } from "../accounting-csv"
import { buildCsv, csvNumber, formatCsvCell } from "../csv"
import {
  dateRangeInTimeZone,
  formatAmount,
  formatIsoDate,
  formatPlainNumber,
  safeFileName,
  startOfDayInTimeZone,
} from "../format"
import {
  electronicAddressFromVat,
  explicitElectronicAddress,
  parseFreeTextAddress,
  toCountryCode,
  vatIdentifier,
} from "../parties"
import { element, escapeXmlAttribute, escapeXmlText, serializeXmlDocument, textElement } from "../xml"

describe("xml builder", () => {
  it("escapes markup in text and attributes", () => {
    expect(escapeXmlText(`Tom & Jerry <b>"hi"</b>`)).toBe(`Tom &amp; Jerry &lt;b&gt;"hi"&lt;/b&gt;`)
    expect(escapeXmlAttribute(`a"b'c<&>`)).toBe("a&quot;b&apos;c&lt;&amp;&gt;")
  })

  it("drops characters XML 1.0 cannot represent", () => {
    expect(escapeXmlText(`a${String.fromCharCode(0)}b${String.fromCharCode(0x1b)}c\td`)).toBe("abc\td")
  })

  it("serializes nested elements and skips empty optional children", () => {
    const xml = serializeXmlDocument(
      element(
        "Root",
        { xmlns: "urn:test", empty: null },
        textElement("Name", "Æble & Co"),
        textElement("Missing", null),
        textElement("Blank", "   "),
        false,
        [textElement("Amount", "1.00", { currencyID: "DKK" })],
        element("Empty", null)
      )
    )
    expect(xml).toBe(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<Root xmlns="urn:test">',
        "  <Name>Æble &amp; Co</Name>",
        '  <Amount currencyID="DKK">1.00</Amount>',
        "  <Empty/>",
        "</Root>",
        "",
      ].join("\n")
    )
  })
})

describe("csv builder", () => {
  it("quotes cells with separators, quotes and line breaks", () => {
    expect(formatCsvCell("plain")).toBe("plain")
    expect(formatCsvCell("a,b")).toBe('"a,b"')
    expect(formatCsvCell('say "hi"')).toBe('"say ""hi"""')
    expect(formatCsvCell("two\nlines")).toBe('"two\nlines"')
    expect(formatCsvCell(null)).toBe("")
    expect(formatCsvCell(undefined)).toBe("")
    expect(formatCsvCell(true)).toBe("true")
  })

  it("neutralizes cells a spreadsheet would run as formulas", () => {
    expect(formatCsvCell("=HYPERLINK(\"http://evil\")")).toBe(`"'=HYPERLINK(""http://evil"")"`)
    expect(formatCsvCell("+1")).toBe("'+1")
    expect(formatCsvCell("-2")).toBe("'-2")
    expect(formatCsvCell("@SUM(A1)")).toBe("'@SUM(A1)")
    expect(formatCsvCell("\tcmd")).toBe("'\tcmd")
    expect(formatCsvCell("safe=value")).toBe("safe=value")
  })

  it("keeps trusted numeric cells as numbers, including negatives", () => {
    expect(formatCsvCell(csvNumber("-12.50"))).toBe("-12.50")
    expect(() => csvNumber("=1+1")).toThrow()
  })

  it("writes CRLF rows and checks the column count", () => {
    expect(buildCsv(["a", "b"], [["1", csvNumber("2.00")]])).toBe("a,b\r\n1,2.00\r\n")
    expect(() => buildCsv(["a", "b"], [["1"]])).toThrow()
  })
})

describe("number and date formatting", () => {
  it("formats amounts with two decimals and half-up rounding", () => {
    expect(formatAmount(1)).toBe("1.00")
    expect(formatAmount("1234.5")).toBe("1234.50")
    expect(formatAmount("0.125")).toBe("0.13")
    expect(formatAmount("-0.001")).toBe("0.00")
    expect(formatAmount(-5)).toBe("-5.00")
  })

  it("formats quantities and rates without trailing zeros", () => {
    expect(formatPlainNumber("2.00")).toBe("2")
    expect(formatPlainNumber("12.50")).toBe("12.5")
    expect(formatPlainNumber(0)).toBe("0")
  })

  it("formats dates in a time zone", () => {
    const instant = new Date("2026-03-31T23:30:00Z")
    expect(formatIsoDate(instant, "UTC")).toBe("2026-03-31")
    expect(formatIsoDate(instant, "Europe/Copenhagen")).toBe("2026-04-01")
    expect(formatIsoDate(instant, "Not/AZone")).toBe("2026-03-31")
  })

  it("computes day boundaries across daylight saving changes", () => {
    expect(startOfDayInTimeZone("2026-01-15", "Europe/Copenhagen").toISOString()).toBe(
      "2026-01-14T23:00:00.000Z"
    )
    expect(startOfDayInTimeZone("2026-07-15", "Europe/Copenhagen").toISOString()).toBe(
      "2026-07-14T22:00:00.000Z"
    )
    const range = dateRangeInTimeZone("2026-03-01", "2026-03-31", "Europe/Copenhagen")
    expect(range.start.toISOString()).toBe("2026-02-28T23:00:00.000Z")
    expect(range.end.toISOString()).toBe("2026-03-31T22:00:00.000Z")
    expect(dateRangeInTimeZone("2026-12-31", "2026-12-31", "UTC").end.toISOString()).toBe(
      "2027-01-01T00:00:00.000Z"
    )
  })

  it("makes safe file names", () => {
    expect(safeFileName("INV/2026 #1")).toBe("INV-2026-1")
    expect(safeFileName("../..")).toBe("document")
  })
})

describe("party normalization", () => {
  it("resolves country codes and names", () => {
    expect(toCountryCode("dk")).toBe("DK")
    expect(toCountryCode("Denmark")).toBe("DK")
    expect(toCountryCode("Danmark")).toBe("DK")
    expect(toCountryCode("Deutschland")).toBe("DE")
    expect(toCountryCode("United States")).toBe("US")
    expect(toCountryCode("ZZ")).toBeNull()
    expect(toCountryCode("Atlantis")).toBeNull()
    expect(toCountryCode("")).toBeNull()
  })

  it("splits free-text addresses into street, postcode and city", () => {
    expect(parseFreeTextAddress("Vesterbrogade 1\n1620 København V\nDenmark", "DK")).toEqual({
      street: "Vesterbrogade 1",
      additionalStreet: null,
      city: "København V",
      postalZone: "1620",
      region: null,
    })
    expect(parseFreeTextAddress("Damrak 1, 1012 LG Amsterdam", "NL")).toMatchObject({
      street: "Damrak 1",
      postalZone: "1012 LG",
      city: "Amsterdam",
    })
    expect(parseFreeTextAddress(null)).toMatchObject({ street: null, city: null })
  })

  it("normalizes VAT identifiers with their country prefix", () => {
    expect(vatIdentifier([{ scheme: "vat", value: "12 34 56 78" }], "DK")).toBe("DK12345678")
    expect(vatIdentifier([{ scheme: "vat", value: "de123456789" }], "DE")).toBe("DE123456789")
    expect(vatIdentifier([{ scheme: "cvr", value: "12345678" }], "DK")).toBe("DK12345678")
    expect(vatIdentifier([{ scheme: "vat", value: "123456789" }], "GR")).toBe("EL123456789")
    expect(vatIdentifier([{ scheme: "ein", value: "12-3456789" }], "US")).toBeNull()
    expect(vatIdentifier([{ scheme: "vat", value: "12345678" }], null)).toBeNull()
  })

  it("derives Peppol electronic addresses", () => {
    expect(electronicAddressFromVat("DK12345678")).toEqual({ scheme: "0184", id: "12345678" })
    expect(electronicAddressFromVat("DE123456789")).toEqual({ scheme: "9930", id: "DE123456789" })
    expect(electronicAddressFromVat("NO123456789MVA")).toEqual({ scheme: "0192", id: "123456789" })
    expect(electronicAddressFromVat("US123")).toBeNull()
    expect(explicitElectronicAddress(" 5790000000001 ", "0088")).toEqual({
      scheme: "0088",
      id: "5790000000001",
    })
    expect(explicitElectronicAddress("5790000000001", "GLN")).toBeNull()
    expect(explicitElectronicAddress(null, "0088")).toBeNull()
  })
})

describe("accounting csv", () => {
  const header = (dataset: keyof typeof ACCOUNTING_EXPORT_COLUMNS) =>
    `${ACCOUNTING_EXPORT_COLUMNS[dataset].join(",")}\r\n`

  it("writes the invoice column contract", () => {
    const csv = invoicesCsv(
      [
        {
          number: "INV-0001",
          issueDate: new Date("2026-03-01T10:00:00Z"),
          dueDate: new Date("2026-03-31T10:00:00Z"),
          customer: "=cmd|' /C calc'!A0",
          currency: "DKK",
          net: "100",
          tax: "25",
          gross: "125",
          paid: "25",
          credited: "0",
          balance: "100",
          status: "sent",
        },
      ],
      "Europe/Copenhagen"
    )
    expect(csv).toBe(
      `${header("invoices")}INV-0001,2026-03-01,2026-03-31,'=cmd|' /C calc'!A0,DKK,100.00,25.00,125.00,25.00,0.00,100.00,sent\r\n`
    )
  })

  it("writes the credit note and payment column contracts", () => {
    expect(
      creditNotesCsv(
        [
          {
            number: "CN-0001",
            invoiceNumber: "INV-0001",
            issueDate: new Date("2026-03-02T00:00:00Z"),
            customer: "Acme, Inc.",
            currency: "EUR",
            net: "10",
            tax: "2.5",
            gross: "12.5",
            reason: "Returned goods",
          },
        ],
        "UTC"
      )
    ).toBe(`${header("creditNotes")}CN-0001,INV-0001,2026-03-02,"Acme, Inc.",EUR,10.00,2.50,12.50,Returned goods\r\n`)

    expect(
      paymentsCsv(
        [
          {
            paidAt: new Date("2026-03-03T00:00:00Z"),
            invoiceNumber: "INV-0001",
            customer: "Acme",
            currency: "EUR",
            amount: "50",
            method: "bank_transfer",
            reference: "+REF",
            voidedAt: new Date(),
            voidReason: "Bounced",
          },
        ],
        "UTC"
      )
    ).toBe(`${header("payments")}2026-03-03,INV-0001,Acme,EUR,50.00,bank_transfer,'+REF,true,Bounced\r\n`)
  })
})
