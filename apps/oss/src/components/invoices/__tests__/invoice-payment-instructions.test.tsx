import { describe, expect, it } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { computeSettlement } from "../../../domain/documents/settlement"
import fixture from "../../../domain/events/__tests__/fixtures/invoice.issued.v1.json"
import { I18nProvider } from "../../../lib/i18n/react"
import { InvoiceSellerDetails, InvoicePaymentInstructions } from "../invoice-payment-instructions"

const sellerSnapshot = {
  companyName: "Synthetic Seller ApS", companyAddress: "Testvej 1\n1000 København",
  taxIds: [{ scheme: "cvr", countryCode: "DK", value: "12345678" }],
  bankAccount: { regNumber: "0040", accountNumber: "0440116243" }, paymentNote: "Frozen note",
}

describe("invoice detail seller and payment blocks", () => {
  it.each(["da-DK", "en-US"])("renders the invoice's frozen seller and payment data in %s", locale => {
    const html = renderToStaticMarkup(<I18nProvider locale={locale}>
      <InvoiceSellerDetails status="sent" sellerSnapshot={sellerSnapshot} />
      <InvoicePaymentInstructions status="sent" sellerSnapshot={sellerSnapshot} number="INV-0042" balanceDue={250} currency="DKK" dueDate="2026-03-23" />
    </I18nProvider>)
    for (const value of ["Synthetic Seller ApS", "Testvej 1", "1000 København", "0040", "0440 116 243", "Frozen note"]) expect(html).toContain(value)
    expect(html).toContain(locale === "da-DK" ? "CVR-nr. 12345678" : "CVR no. 12345678")
    expect(html).toContain(locale === "da-DK" ? 'aria-label="Fra"' : 'aria-label="From"')
    expect(html).toContain(locale === "da-DK" ? "Skriv fakturanummeret i beskeden, så vi kan finde din betaling." : "Add the invoice number to the payment message so we can match your payment.")
    expect(html).toContain(locale === "da-DK" ? "Betalingsbesked" : "Payment message")
    expect(html).toContain(locale === "da-DK" ? "23. mar. 2026" : "23 Mar 2026")
    expect(html).not.toMatch(/Payment reference|Betalingsreference|\+71/)
  })

  it.each([
    ["en-US", /DKK\s22,500\.00/, "9 Nov 2026"],
    ["da-DK", /22\.500,00\skr\./, "9. nov. 2026"],
  ])("writes a DKK amount and the due date in the interface's %s", (locale, amount, dueDate) => {
    const html = renderToStaticMarkup(<I18nProvider locale={locale}><InvoicePaymentInstructions status="sent" sellerSnapshot={sellerSnapshot} number="INV-0042" balanceDue={22500} currency="DKK" dueDate="2026-11-09" /></I18nProvider>)
    expect(html).toMatch(amount)
    expect(html).toContain(dueDate)
  })

  it.each(["da-DK", "en-US"])("hides the creation-time seller while the invoice is a draft in %s", locale => {
    const html = renderToStaticMarkup(<I18nProvider locale={locale}><InvoiceSellerDetails status="draft" sellerSnapshot={sellerSnapshot} /></I18nProvider>)
    expect(html).toBe("")
  })

  it.each([null, {}, { companyName: 42 }])("hides absent or invalid bank data: %s", snapshot => {
    const html = renderToStaticMarkup(<I18nProvider locale="en-US"><InvoicePaymentInstructions status="sent" sellerSnapshot={snapshot} number="INV-0042" balanceDue={250} currency="DKK" dueDate="2026-03-23" /></I18nProvider>)
    expect(html).toBe("")
  })

  it("shows a custom payment note once and drops a note that only repeats the non-VAT statement", () => {
    const statement = "No VAT charged – the seller is not VAT-registered."
    const seller = { ...sellerSnapshot, momsRegistered: false as const, paymentNote: `Pay by transfer\n${statement}` }
    const mixed = renderToStaticMarkup(<I18nProvider locale="en-US"><InvoicePaymentInstructions status="sent" sellerSnapshot={seller} number="INV-0042" balanceDue={250} currency="DKK" dueDate="2026-03-23" /></I18nProvider>)
    expect(mixed).toContain("Pay by transfer")
    expect(mixed).not.toContain(statement)
    const onlyStatement = renderToStaticMarkup(<I18nProvider locale="en-US"><InvoicePaymentInstructions status="sent" sellerSnapshot={{ ...seller, paymentNote: statement }} number="INV-0042" balanceDue={250} currency="DKK" dueDate="2026-03-23" /></I18nProvider>)
    expect(onlyStatement).toContain("0040")
    expect(onlyStatement).not.toContain(statement)
  })

  it("shows a payment note without bank rows and never assigns a draft number", () => {
    const html = renderToStaticMarkup(<I18nProvider locale="en-US"><InvoicePaymentInstructions status="sent" sellerSnapshot={{ paymentNote: "Pay on delivery" }} number={null} balanceDue={250} currency="DKK" dueDate="2026-03-23" /></I18nProvider>)
    expect(html).toContain("Pay on delivery")
    expect(html).not.toMatch(/Reg. no.|Account number|Put invoice number/)
  })
})

// MOCK: synthetic issued account and outstanding balances, confined to tests.
describe("issued payment block regressions", () => {
  for (const locale of ["da-DK", "en-US"]) {
    it.each([
      ["  ORDER-2026-42  ", "ORDER-2026-42"],
      ["  ", "INV-0042"],
      [null, "INV-0042"],
      [undefined, "INV-0042"],
      ["  INV-0042  ", "INV-0042"],
    ])(`renders matching ${locale} payment rows and hints: %s`, (paymentReference, expected) => {
      const html = renderToStaticMarkup(<I18nProvider locale={locale}><InvoicePaymentInstructions status="sent" sellerSnapshot={sellerSnapshot} number="INV-0042" paymentReference={paymentReference} balanceDue={250} currency="DKK" dueDate="2026-03-23" /></I18nProvider>)
      expect(html).toContain(`<dd class="font-mono text-right break-words">${expected}</dd>`)
      const defaultHint = locale === "da-DK" ? "Skriv fakturanummeret i beskeden, så vi kan finde din betaling." : "Add the invoice number to the payment message so we can match your payment."
      if (expected === "INV-0042") expect(html).toContain(defaultHint)
      else {
        expect(html).toContain(locale === "da-DK" ? `Skriv ${expected} i beskeden, så vi kan finde din betaling.` : `Add ${expected} to the payment message so we can match your payment.`)
        expect(html).not.toContain(defaultHint)
        expect(html).not.toContain("INV-0042")
      }
    })
  }

  it("escapes a custom reference in both the detail row and hint", () => {
    const html = renderToStaticMarkup(<I18nProvider locale="en-US"><InvoicePaymentInstructions status="sent" sellerSnapshot={sellerSnapshot} number="INV-0042" paymentReference="<img src=x>" balanceDue={250} currency="DKK" dueDate="2026-03-23" /></I18nProvider>)
    expect(html).toContain("Add &lt;img src=x&gt; to the payment message so we can match your payment.")
    expect(html).not.toContain("<img")
  })

  it("shows an IBAN-only destination", () => {
    const html = renderToStaticMarkup(<I18nProvider locale="en-US"><InvoicePaymentInstructions status="sent" sellerSnapshot={{ bankAccount: { iban: "DK5000400440116243", bic: "DABADKKK" } }} number="INV-0042" balanceDue={250} currency="DKK" dueDate="2026-03-23" /></I18nProvider>)
    expect(html).toContain("DK50 0040 0440 1162 43")
    expect(html).toContain("DABADKKK")
  })

  it.each([1000, 750])("shows the supplied outstanding amount %s", balanceDue => {
    const html = renderToStaticMarkup(<I18nProvider locale="en-US"><InvoicePaymentInstructions status="sent" sellerSnapshot={sellerSnapshot} number="INV-0042" balanceDue={balanceDue} currency="USD" dueDate="2026-03-23" /></I18nProvider>)
    expect(html).toContain(balanceDue === 1000 ? "$1,000.00" : "$750.00")
    expect(html).toContain("INV-0042")
  })

  it("hides draft creation-time payment details even after settings change", () => {
    const html = renderToStaticMarkup(<I18nProvider locale="en-US"><InvoicePaymentInstructions status="draft" sellerSnapshot={sellerSnapshot} number={null} balanceDue={250} currency="DKK" dueDate="2026-03-23" /></I18nProvider>)
    expect(html).toBe("")
  })
})

// MOCK: synthetic currency-unit amounts processed by the real settlement calculator.
describe("settled invoice detail payment instructions", () => {
  for (const locale of ["da-DK", "en-US"]) {
    it.each([
      { status: "paid", amountPaid: 1000, amountCredited: 0 },
      { status: "credited", amountPaid: 0, amountCredited: 1000 },
      { status: "paid", amountPaid: 750, amountCredited: 250 },
      { status: "sent", amountPaid: 1000, amountCredited: 0 },
    ])(`hides payment instructions when nothing remains owed in ${locale}: $status`, ({ status, amountPaid, amountCredited }) => {
      const settlement = computeSettlement({ totalGross: 1000, amountPaid, amountCredited })
      const html = renderToStaticMarkup(<I18nProvider locale={locale}>
        <InvoicePaymentInstructions status={status} sellerSnapshot={sellerSnapshot} number="INV-0042" paymentReference="ORDER-2026-42" balanceDue={settlement.balanceDue.toNumber()} currency="USD" dueDate="2026-03-23" />
      </I18nProvider>)
      expect(html).toBe("")
      const sellerHtml = renderToStaticMarkup(<I18nProvider locale={locale}>
        <InvoiceSellerDetails status={status} sellerSnapshot={sellerSnapshot} />
      </I18nProvider>)
      expect(sellerHtml).toContain("Synthetic Seller ApS")
    })

    it(`keeps the remaining partial-payment amount and frozen destination/reference in ${locale}`, () => {
      const settlement = computeSettlement({ totalGross: 1000, amountPaid: 250, amountCredited: 0 })
      const html = renderToStaticMarkup(<I18nProvider locale={locale}>
        <InvoicePaymentInstructions status="sent" sellerSnapshot={sellerSnapshot} number="INV-0042" paymentReference="ORDER-2026-42" balanceDue={settlement.balanceDue.toNumber()} currency="USD" dueDate="2026-03-23" />
      </I18nProvider>)
      expect(html).toContain(locale === "da-DK" ? 'aria-label="Sådan betaler du"' : 'aria-label="How to pay"')
      expect(html).toContain(locale === "da-DK" ? "750,00" : "$750.00")
      expect(html).not.toContain(locale === "da-DK" ? "1.000,00" : "$1,000.00")
      for (const value of ["0040", "0440 116 243", "ORDER-2026-42", "Frozen note"]) expect(html).toContain(value)
      expect(html).toContain(locale === "da-DK" ? "Skriv ORDER-2026-42 i beskeden, så vi kan finde din betaling." : "Add ORDER-2026-42 to the payment message so we can match your payment.")
    })
  }

  it("shows the issued seller and bank details when the row snapshot differs", () => {
    const issuanceSnapshot = {
      ...fixture.cases[0]!.payload,
      seller: {
        companyName: "Frozen Seller",
        companyAddress: "Testvej 42\n9000 Aalborg",
        taxIds: [{ scheme: "cvr", countryCode: "DK", value: "87654321" }],
        bankAccount: { regNumber: "5678", accountNumber: "0123456789" },
        paymentNote: "Issue-time note",
      },
    }
    const html = renderToStaticMarkup(<I18nProvider locale="en-US">
      <InvoiceSellerDetails status="sent" sellerSnapshot={sellerSnapshot} issuanceSnapshot={issuanceSnapshot} />
      <InvoicePaymentInstructions status="sent" sellerSnapshot={sellerSnapshot} issuanceSnapshot={issuanceSnapshot} number="INV-0042" balanceDue={1750} currency="DKK" dueDate="2026-03-23" />
    </I18nProvider>)
    for (const value of ["Frozen Seller", "Testvej 42", "9000 Aalborg", "CVR no. 87654321", "5678", "0123 456 789", "Issue-time note", "DKK\u00a01,750.00"]) {
      expect(html).toContain(value)
    }
    for (const stale of ["Synthetic Seller ApS", "12345678", "0040", "0440 116 243", "Frozen note"]) {
      expect(html).not.toContain(stale)
    }
  })
})
