import { PEPPOL_BIS_CUSTOMIZATION_ID, PEPPOL_BIS_PROFILE_ID } from "@quits/contracts/exports"
import { describe, expect, it } from "vitest"
import {
  buildUblDocument,
  computeEinvoiceTotals,
  linePrice,
  taxCategoryCode,
  validateEinvoice,
  type EinvoiceDocument,
  type EinvoiceParty,
} from "../ubl"

const seller: EinvoiceParty = {
  name: "Nordic Design ApS",
  street: "Vesterbrogade 1",
  additionalStreet: null,
  city: "København V",
  postalZone: "1620",
  region: null,
  countryCode: "DK",
  vatId: "DK12345678",
  legalId: { id: "12345678", scheme: "0184" },
  electronicAddress: { scheme: "0184", id: "12345678" },
  email: "billing@nordic.test",
}

const buyer: EinvoiceParty = {
  name: "Acme & Sons <GmbH>",
  street: "Hauptstraße 5",
  additionalStreet: null,
  city: "Berlin",
  postalZone: "10115",
  region: null,
  countryCode: "DE",
  vatId: "DE123456789",
  legalId: null,
  electronicAddress: { scheme: "9930", id: "DE123456789" },
  email: null,
}

function invoice(overrides: Partial<EinvoiceDocument> = {}): EinvoiceDocument {
  return {
    kind: "invoice",
    issued: true,
    number: "INV-0007",
    issueDate: "2026-10-01",
    dueDate: "2026-10-31",
    deliveryDate: null,
    currency: "DKK",
    buyerReference: "PO-42",
    orderReference: "PO-42",
    billingReference: null,
    note: null,
    seller,
    buyer,
    lines: [
      { description: "Design", quantity: "2", unitPriceNet: "100", lineNet: "200", taxRate: "25", taxCategory: "standard" },
      { description: "Hosting", quantity: "3", unitPriceNet: "33.33", lineNet: "99.99", taxRate: "25", taxCategory: "standard" },
      { description: "Book", quantity: "1", unitPriceNet: "50", lineNet: "50", taxRate: "0", taxCategory: "exempt" },
    ],
    storedGross: "424.99",
    amountPaid: "100",
    ...overrides,
  }
}

function between(xml: string, tag: string) {
  return [...xml.matchAll(new RegExp(`<${tag}(?: [^>]*)?>([^<]*)</${tag}>`, "g"))].map((match) => match[1])
}

describe("UBL e-invoice", () => {
  it("maps tax categories from rates", () => {
    expect(taxCategoryCode({ taxRate: "25", taxCategory: "standard" })).toBe("S")
    expect(taxCategoryCode({ taxRate: "0", taxCategory: "zero" })).toBe("Z")
    expect(taxCategoryCode({ taxRate: "0", taxCategory: "standard" })).toBe("E")
  })

  it("derives totals that satisfy the EN 16931 sum rules", () => {
    const totals = computeEinvoiceTotals(invoice())
    expect(totals).toEqual({
      lineExtension: "349.99",
      taxExclusive: "349.99",
      tax: "75.00",
      taxInclusive: "424.99",
      prepaid: "100.00",
      rounding: "0.00",
      payable: "324.99",
      groups: [
        { category: "E", rate: "0", taxable: "50.00", tax: "0.00" },
        { category: "S", rate: "25", taxable: "299.99", tax: "75.00" },
      ],
    })
  })

  it("carries cent differences to the stored gross total as rounding", () => {
    const totals = computeEinvoiceTotals(invoice({ storedGross: "425.00", amountPaid: 0 }))
    expect(totals.rounding).toBe("0.01")
    expect(totals.payable).toBe("425.00")
  })

  it("keeps quantity x price equal to the line net", () => {
    expect(linePrice({ quantity: "3", unitPriceNet: "33.33", lineNet: "99.99" })).toBe("33.33")
    expect(linePrice({ quantity: "3", unitPriceNet: "26.67", lineNet: "80" })).toBe("26.666667")
  })

  it("writes a Peppol BIS Billing 3.0 invoice", () => {
    const xml = buildUblDocument(invoice({ note: "Thanks & welcome" }))

    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"')).toBe(true)
    expect(between(xml, "cbc:CustomizationID")).toEqual([PEPPOL_BIS_CUSTOMIZATION_ID])
    expect(between(xml, "cbc:ProfileID")).toEqual([PEPPOL_BIS_PROFILE_ID])
    expect(between(xml, "cbc:InvoiceTypeCode")).toEqual(["380"])
    expect(between(xml, "cbc:DueDate")).toEqual(["2026-10-31"])
    expect(between(xml, "cbc:DocumentCurrencyCode")).toEqual(["DKK"])
    expect(between(xml, "cbc:Note")).toEqual(["Thanks &amp; welcome"])
    expect(xml).toContain('<cbc:EndpointID schemeID="0184">12345678</cbc:EndpointID>')
    expect(xml).toContain('<cbc:EndpointID schemeID="9930">DE123456789</cbc:EndpointID>')
    expect(xml).toContain("<cbc:Name>Acme &amp; Sons &lt;GmbH&gt;</cbc:Name>")
    expect(between(xml, "cbc:IdentificationCode")).toEqual(["DK", "DE"])
    expect(between(xml, "cbc:CompanyID")).toEqual(["DK12345678", "12345678", "DE123456789"])
    // DK-R-002 / DK-R-014: a Danish supplier's legal entity is its CVR with scheme 0184.
    expect(xml).toMatch(
      /<cac:PartyLegalEntity>\s*<cbc:RegistrationName>Nordic Design ApS<\/cbc:RegistrationName>\s*<cbc:CompanyID schemeID="0184">12345678<\/cbc:CompanyID>/
    )
    expect(xml).toContain("<cac:OrderReference>")
    expect(xml).not.toContain("BillingReference")

    // Every amount carries the document currency and two decimals.
    const amounts = [...xml.matchAll(/<cbc:(\w+Amount) currencyID="(\w+)">([^<]+)</g)]
    expect(amounts.length).toBeGreaterThan(10)
    for (const [, name, currency, value] of amounts) {
      expect(currency).toBe("DKK")
      if (name !== "PriceAmount") expect(value).toMatch(/^-?\d+\.\d{2}$/)
    }

    expect(xml).toContain('<cbc:PrepaidAmount currencyID="DKK">100.00</cbc:PrepaidAmount>')
    expect(xml).toContain('<cbc:PayableAmount currencyID="DKK">324.99</cbc:PayableAmount>')
    expect(xml).toContain('<cbc:TaxExemptionReason>Exempt from VAT</cbc:TaxExemptionReason>')

    const lineNets = between(xml, "cbc:LineExtensionAmount").map(Number)
    const [documentTotal, ...lines] = lineNets
    expect(lines).toEqual([200, 99.99, 50])
    expect(lines.reduce((sum, value) => sum + value, 0)).toBeCloseTo(documentTotal!, 2)
    expect(xml.match(/<cac:InvoiceLine>/g)).toHaveLength(3)
    expect(xml).toContain('<cbc:InvoicedQuantity unitCode="C62">2</cbc:InvoicedQuantity>')
  })

  it("orders the header elements as the UBL schema requires", () => {
    const xml = buildUblDocument(invoice({ deliveryDate: "2026-09-30" }))
    const order = [
      "cbc:CustomizationID",
      "cbc:ProfileID",
      "<cbc:ID>INV-0007",
      "cbc:IssueDate",
      "cbc:DueDate",
      "cbc:InvoiceTypeCode",
      "cbc:DocumentCurrencyCode",
      "cbc:BuyerReference",
      "cac:OrderReference",
      "cac:AccountingSupplierParty",
      "cac:AccountingCustomerParty",
      "cac:Delivery",
      "cac:TaxTotal",
      "cac:LegalMonetaryTotal",
      "cac:InvoiceLine",
    ].map((needle) => xml.indexOf(needle))
    expect(order.every((index) => index >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  describe("payment means", () => {
    const payment = {
      meansCode: "58",
      accountId: "DK5000400440116243",
      accountName: null,
      branchId: "DABADKKK",
      reference: "INV-0007",
    }

    const meansXml = (code: string, accountId: string, branchId: string, name?: string) =>
      new RegExp(
        `<cac:PaymentMeans>\\s*<cbc:PaymentMeansCode>${code}</cbc:PaymentMeansCode>\\s*<cbc:PaymentID>INV-0007</cbc:PaymentID>\\s*<cac:PayeeFinancialAccount>\\s*<cbc:ID>${accountId}</cbc:ID>\\s*${
          name ? `<cbc:Name>${name}</cbc:Name>\\s*` : ""
        }<cac:FinancialInstitutionBranch>\\s*<cbc:ID>${branchId}</cbc:ID>\\s*</cac:FinancialInstitutionBranch>\\s*</cac:PayeeFinancialAccount>\\s*</cac:PaymentMeans>`
      )

    it("writes the resolved means code, account, branch and payment reference", () => {
      const xml = buildUblDocument(invoice({ currency: "EUR", payment }))

      expect(between(xml, "cbc:PaymentMeansCode")).toEqual(["58"])
      expect(between(xml, "cbc:PaymentID")).toEqual(["INV-0007"])
      expect(xml).toMatch(meansXml("58", "DK5000400440116243", "DABADKKK"))
    })

    it("writes a Danish bank account (42) with the reg.nr. as the branch", () => {
      const xml = buildUblDocument(
        invoice({ payment: { ...payment, meansCode: "42", accountId: "0440116243", branchId: "0040" } })
      )
      expect(xml).toMatch(meansXml("42", "0440116243", "0040"))
    })

    it("writes the account holder (BT-85) as cbc:Name between the account ID and the branch", () => {
      const xml = buildUblDocument(invoice({ payment: { ...payment, accountName: "Nordic Design ApS" } }))
      expect(xml).toMatch(meansXml("58", "DK5000400440116243", "DABADKKK", "Nordic Design ApS"))
    })

    it("escapes the account holder", () => {
      const xml = buildUblDocument(invoice({ payment: { ...payment, accountName: "Smith & <Sons>" } }))
      expect(between(xml, "cbc:Name")).toContain("Smith &amp; &lt;Sons&gt;")
    })

    it("places the payment means between the delivery and the tax total", () => {
      const xml = buildUblDocument(invoice({ deliveryDate: "2026-10-01", payment }))
      const order = ["cac:AccountingCustomerParty", "cac:Delivery", "cac:PaymentMeans", "cac:TaxTotal"].map((needle) =>
        xml.indexOf(needle)
      )
      expect(order.every((index) => index >= 0)).toBe(true)
      expect([...order].sort((a, b) => a - b)).toEqual(order)
    })

    it("omits the branch and the name when there are none", () => {
      const xml = buildUblDocument(invoice({ payment: { ...payment, branchId: null } }))
      expect(between(xml, "cbc:ID")).toContain("DK5000400440116243")
      expect(xml).not.toContain("FinancialInstitutionBranch")
      expect(xml.match(/<cac:PayeeFinancialAccount>[\s\S]*?<\/cac:PayeeFinancialAccount>/)?.[0]).not.toContain("<cbc:Name>")
    })

    it("writes no payment means without payment instructions", () => {
      expect(buildUblDocument(invoice())).not.toContain("PaymentMeans")
      expect(buildUblDocument(invoice({ payment: null }))).not.toContain("PaymentMeans")
    })

    it("leaves credit notes without payment means", () => {
      const xml = buildUblDocument(
        invoice({
          kind: "creditNote",
          number: "CN-0001",
          dueDate: null,
          billingReference: { number: "INV-0007", issueDate: "2026-10-01" },
          amountPaid: 0,
          payment,
        })
      )
      expect(xml).not.toContain("PaymentMeans")
    })
  })

  describe("Danish payment means rules", () => {
    const danishBuyer: EinvoiceParty = {
      ...buyer,
      countryCode: "DK",
      vatId: "DK87654321",
      legalId: { id: "87654321", scheme: "0184" },
      electronicAddress: { scheme: "0184", id: "87654321" },
    }
    const means = (overrides: Partial<NonNullable<EinvoiceDocument["payment"]>>) => ({
      meansCode: "42",
      accountId: "0440116243",
      accountName: null,
      branchId: "0040",
      reference: "INV-0007",
      ...overrides,
    })
    const domestic = (payment: EinvoiceDocument["payment"]) => invoice({ buyer: danishBuyer, payment })

    it("passes DK-R-005 and DK-R-006 for a Danish bank account (42)", () => {
      expect(validateEinvoice(domestic(means({})))).toEqual([])
    })

    it.each([["1"], ["10"], ["31"], ["42"], ["48"], ["49"], ["50"], ["58"], ["59"], ["93"], ["97"]])(
      "DK-R-005 allows means code %s between two Danish parties",
      (meansCode) => {
        expect(validateEinvoice(domestic(means({ meansCode })))).toEqual([])
      }
    )

    it.each([["30"], ["2"], ["20"], ["57"], ["ZZZ"]])(
      "DK-R-005 rejects means code %s between two Danish parties",
      (meansCode) => {
        expect(validateEinvoice(domestic(means({ meansCode })))).toEqual(["seller.paymentMeansCode"])
      }
    )

    it("applies DK-R-005 only when both parties are Danish", () => {
      expect(validateEinvoice(invoice({ payment: means({ meansCode: "30" }) }))).toEqual([])
      const foreignSeller = invoice({ seller: { ...seller, countryCode: "SE" }, buyer: danishBuyer, payment: means({ meansCode: "30" }) })
      expect(validateEinvoice(foreignSeller)).not.toContain("seller.paymentMeansCode")
    })

    it.each([["31"], ["42"]])("DK-R-006 needs the branch for code %s", (meansCode) => {
      expect(validateEinvoice(domestic(means({ meansCode, branchId: null })))).toEqual(["seller.paymentAccountBranch"])
      expect(validateEinvoice(domestic(means({ meansCode, branchId: "  " })))).toEqual(["seller.paymentAccountBranch"])
      expect(validateEinvoice(domestic(means({ meansCode, accountId: " " })))).toEqual(["seller.paymentAccountBranch"])
    })

    it("does not need the branch for code 58 or outside Denmark", () => {
      expect(validateEinvoice(domestic(means({ meansCode: "58", branchId: null })))).toEqual([])
      expect(validateEinvoice(invoice({ payment: means({ branchId: null }) }))).toEqual([])
    })

    it("accepts a document without payment means", () => {
      expect(validateEinvoice(domestic(null))).toEqual([])
    })

    it("does not change the missing-data check for other pairs", () => {
      expect(validateEinvoice(invoice({ payment: means({ meansCode: "30", accountId: "DK5000400440116243" }) }))).toEqual([])
    })
  })

  it("writes a credit note with a billing reference to the invoice", () => {
    const xml = buildUblDocument(
      invoice({
        kind: "creditNote",
        number: "CN-0001",
        dueDate: null,
        orderReference: null,
        billingReference: { number: "INV-0007", issueDate: "2026-10-01" },
        note: "Returned goods",
        amountPaid: 0,
        lines: [{ description: "Design", quantity: "1", unitPriceNet: "100", lineNet: "100", taxRate: "25", taxCategory: "standard" }],
        storedGross: "125",
      })
    )

    expect(xml).toContain('<CreditNote xmlns="urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2"')
    expect(between(xml, "cbc:CreditNoteTypeCode")).toEqual(["381"])
    expect(xml).not.toContain("cbc:DueDate")
    expect(xml).not.toContain("InvoiceTypeCode")
    expect(xml).toMatch(
      /<cac:BillingReference>\s*<cac:InvoiceDocumentReference>\s*<cbc:ID>INV-0007<\/cbc:ID>\s*<cbc:IssueDate>2026-10-01<\/cbc:IssueDate>/
    )
    expect(xml).toContain('<cbc:CreditedQuantity unitCode="C62">1</cbc:CreditedQuantity>')
    expect(xml).toContain("<cac:CreditNoteLine>")
    expect(xml).toContain('<cbc:PayableAmount currencyID="DKK">125.00</cbc:PayableAmount>')
    expect(xml).not.toContain("PrepaidAmount")
  })

  it("lists missing BIS data instead of producing a file", () => {
    expect(validateEinvoice(invoice())).toEqual([])

    const incomplete = invoice({
      issued: false,
      lines: [],
      seller: { ...seller, countryCode: null, vatId: null, electronicAddress: null },
      buyer: { ...buyer, street: null, city: null, countryCode: null, electronicAddress: null },
    })
    expect(validateEinvoice(incomplete)).toEqual([
      "document.notIssued",
      "document.lines",
      "seller.country",
      "seller.taxId",
      "seller.electronicAddress",
      "buyer.country",
      "buyer.address",
      "buyer.electronicAddress",
    ])
    expect(validateEinvoice(invoice({ kind: "creditNote", billingReference: null }))).toEqual([
      "creditNote.invoiceReference",
    ])
  })

  it("requires a CVR with scheme 0184 for Danish suppliers (DK-R-002, DK-R-014)", () => {
    expect(validateEinvoice(invoice({ seller: { ...seller, legalId: null } }))).toEqual(["seller.legalId"])
    expect(
      validateEinvoice(invoice({ seller: { ...seller, legalId: { id: "12345678", scheme: null } } }))
    ).toEqual(["seller.legalId"])
    // Outside Denmark the legal entity identifier stays optional.
    expect(
      validateEinvoice(invoice({ seller: { ...buyer, name: "Acme GmbH" }, buyer: { ...seller } }))
    ).toEqual([])
  })

  it("writes registration numbers without a known scheme without schemeID", () => {
    const xml = buildUblDocument(invoice({ buyer: { ...buyer, legalId: { id: "HRB 1234", scheme: null } } }))
    expect(xml).toContain("<cbc:CompanyID>HRB 1234</cbc:CompanyID>")
  })

  it("rejects endpoints whose scheme or identifier is not valid Peppol (BR-CL-25)", () => {
    expect(
      validateEinvoice(invoice({ buyer: { ...buyer, electronicAddress: { scheme: "1234", id: "DE123456789" } } }))
    ).toEqual(["buyer.electronicAddressInvalid"])
    expect(
      validateEinvoice(invoice({ buyer: { ...buyer, electronicAddress: { scheme: "0088", id: "12345" } } }))
    ).toEqual(["buyer.electronicAddressInvalid"])
    expect(
      validateEinvoice(invoice({ seller: { ...seller, electronicAddress: { scheme: "0184", id: "1234" } } }))
    ).toEqual(["seller.electronicAddressInvalid"])
  })

  it("rejects endpoints that break the PEPPOL-COMMON rules, checking the exact exported value", () => {
    expect(
      validateEinvoice(invoice({ buyer: { ...buyer, electronicAddress: { scheme: "9944", id: "NL12" } } }))
    ).toEqual(["buyer.electronicAddressInvalid"])
    expect(
      validateEinvoice(invoice({ buyer: { ...buyer, electronicAddress: { scheme: "0192", id: "123456789" } } }))
    ).toEqual(["buyer.electronicAddressInvalid"])
    expect(
      validateEinvoice(invoice({ buyer: { ...buyer, electronicAddress: { scheme: "9944", id: "nl123456789b01" } } }))
    ).toEqual(["buyer.electronicAddressInvalid"])
  })

  it("rejects legal identifiers with a scheme whose value breaks its rule (PEPPOL-COMMON-R040)", () => {
    expect(
      validateEinvoice(invoice({ buyer: { ...buyer, legalId: { id: "5790000000001", scheme: "0088" } } }))
    ).toEqual(["buyer.legalIdInvalid"])
    expect(
      validateEinvoice(invoice({ seller: { ...seller, legalId: { id: "1234", scheme: "0184" } } }))
    ).toEqual(["seller.legalIdInvalid"])
    expect(
      validateEinvoice(invoice({ buyer: { ...buyer, legalId: { id: "5790000000005", scheme: "0088" } } }))
    ).toEqual([])
  })
})
