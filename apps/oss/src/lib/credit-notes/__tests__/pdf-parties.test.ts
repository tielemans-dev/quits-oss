import { describe, expect, it } from "vitest"
import { creditNotePdfParties } from "../pdf-parties"

const sellerSnapshot = {
  companyName: "Acme ApS",
  companyEmail: "billing@acme.dk",
  companyAddress: "Vesterbrogade 1, 1620 København V",
  taxIds: [
    { scheme: "vat", value: "DK12345678", countryCode: "DK" },
    { scheme: "cvr", value: "12345678", countryCode: "DK" },
  ],
}

const buyerSnapshot = {
  name: "Jane Buyer",
  email: "jane@buyer.example",
  company: "Buyer GmbH",
  address: "Hauptstraße 5",
  city: "Berlin",
  state: null,
  zip: "10115",
  country: "DE",
  taxIds: [{ scheme: "vat", value: "DE123456789" }],
}

const contact = { name: "Renamed Contact", email: "new@buyer.example", company: "Renamed GmbH" }

const issued = { sellerSnapshot, buyerSnapshot, contact, locale: "en" }

describe("credit note PDF parties", () => {
  it("renders the seller from the issued snapshot, not current settings", () => {
    const before = creditNotePdfParties(issued, {
      companyName: "Acme ApS",
      companyEmail: "billing@acme.dk",
      companyAddress: "Vesterbrogade 1, 1620 København V",
    })
    const after = creditNotePdfParties(issued, {
      companyName: "Acme Holding A/S",
      companyEmail: "new@acme.dk",
      companyAddress: "Somewhere else 9",
      companyLogo: "https://acme.example/new-logo.png",
    })

    expect(after.seller).toMatchObject({
      name: "Acme ApS",
      email: "billing@acme.dk",
      address: "Vesterbrogade 1, 1620 København V",
    })
    expect({ ...after.seller, logo: null }).toEqual({ ...before.seller, logo: null })
    // The logo is presentation only and follows current settings.
    expect(after.seller.logo).toBe("https://acme.example/new-logo.png")
  })

  it("renders seller and buyer tax identifiers", () => {
    const { seller, buyer } = creditNotePdfParties(issued, {})
    expect(seller.taxIds).toEqual(["VAT no.: DK12345678", "CVR no.: 12345678"])
    expect(buyer.taxIds).toEqual(["VAT no.: DE123456789"])
  })

  it("translates tax identifier labels", () => {
    const { seller } = creditNotePdfParties({ ...issued, locale: "da" }, {})
    expect(seller.taxIds).toEqual(["Momsnr.: DK12345678", "CVR-nr.: 12345678"])
  })

  it("renders the buyer from the issued snapshot", () => {
    const { buyer } = creditNotePdfParties(issued, {})
    expect(buyer).toMatchObject({
      name: "Jane Buyer",
      email: "jane@buyer.example",
      company: "Buyer GmbH",
      lines: ["Hauptstraße 5", "Berlin, 10115", "DE"],
    })
  })

  it("falls back to current settings and contact when no snapshot was stored", () => {
    const { seller, buyer } = creditNotePdfParties(
      { contact: { name: "Legacy Buyer", city: "Aarhus" } },
      { companyName: "Acme ApS", companyEmail: "billing@acme.dk" }
    )
    expect(seller).toMatchObject({ name: "Acme ApS", email: "billing@acme.dk", taxIds: [] })
    expect(buyer).toMatchObject({ name: "Legacy Buyer", lines: ["Aarhus"], taxIds: [] })
  })
})
