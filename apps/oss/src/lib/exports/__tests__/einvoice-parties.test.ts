import { describe, expect, it } from "vitest"
import { buildBuyerParty, buildSellerParty } from "../einvoice"
import { legalIdentifier } from "../parties"

const contact = {
  name: "Hans Müller",
  email: "hans@acme.test",
  company: "Acme GmbH",
  address: "Hauptstraße 5",
  city: "Berlin",
  state: null,
  zip: "10115",
  country: "Germany",
  taxId: "DE123456789",
  peppolEndpointId: null,
  peppolEndpointScheme: null,
  taxIds: [],
}

describe("e-invoice parties", () => {
  it("builds the seller from its snapshot and falls back to settings", () => {
    const seller = buildSellerParty({
      snapshot: { companyName: "Nordic ApS", companyAddress: null, taxIds: [{ scheme: "cvr", value: "12345678" }] },
      settings: {
        companyName: "Renamed ApS",
        companyAddress: "Vesterbrogade 1\n1620 København V",
        companyEmail: "billing@nordic.test",
        countryCode: "DK",
      },
      taxIds: [],
      documentCountryCode: "DK",
    })
    expect(seller).toMatchObject({
      name: "Nordic ApS",
      street: "Vesterbrogade 1",
      postalZone: "1620",
      city: "København V",
      countryCode: "DK",
      vatId: "DK12345678",
      legalId: { id: "12345678", scheme: "0184" },
      electronicAddress: { scheme: "0184", id: "12345678" },
      email: "billing@nordic.test",
    })
  })

  it("prefers the snapshot for the buyer and the contact's explicit endpoint", () => {
    const fromVat = buildBuyerParty({ name: "Hans Müller", company: "Acme Old GmbH" }, contact)
    expect(fromVat).toMatchObject({
      name: "Acme Old GmbH",
      street: "Hauptstraße 5",
      countryCode: "DE",
      vatId: "DE123456789",
      electronicAddress: { scheme: "9930", id: "DE123456789" },
    })

    const explicit = buildBuyerParty(null, {
      ...contact,
      taxId: null,
      peppolEndpointId: "4000001000005",
      peppolEndpointScheme: "0088",
    })
    expect(explicit.vatId).toBeNull()
    expect(explicit.electronicAddress).toEqual({ scheme: "0088", id: "4000001000005" })
  })

  const danishSettings = {
    companyName: "Nordic ApS",
    companyAddress: "Vesterbrogade 1\n1620 København V",
    companyEmail: null,
    countryCode: "DK",
  }

  it("derives a Danish seller's CVR from its DK VAT number", () => {
    const seller = buildSellerParty({
      snapshot: null,
      settings: danishSettings,
      taxIds: [{ scheme: "vat", value: "DK 12 34 56 78" }],
      documentCountryCode: "DK",
    })
    expect(seller.vatId).toBe("DK12345678")
    expect(seller.legalId).toEqual({ id: "12345678", scheme: "0184" })
  })

  it("prefers the CVR over other registration numbers for Danish parties", () => {
    const seller = buildSellerParty({
      snapshot: null,
      settings: danishSettings,
      taxIds: [
        { scheme: "other", value: "SE-REG-1" },
        { scheme: "cvr", value: "DK87654321" },
      ],
      documentCountryCode: "DK",
    })
    expect(seller.legalId).toEqual({ id: "87654321", scheme: "0184" })
  })

  it("leaves a Danish seller without CVR or VAT without a legal ID", () => {
    const seller = buildSellerParty({ snapshot: null, settings: danishSettings, taxIds: [], documentCountryCode: "DK" })
    expect(seller.legalId).toBeNull()
  })

  it("keeps non-Danish registration numbers without a scheme", () => {
    const buyer = buildBuyerParty(null, {
      ...contact,
      taxIds: [
        { scheme: "vat", value: "DE123456789", countryCode: "DE", isPrimary: true },
        { scheme: "other", value: "HRB 1234", countryCode: "DE", isPrimary: false },
      ],
    })
    expect(buyer.legalId).toEqual({ id: "HRB 1234", scheme: null })
  })

  it("gives a Danish buyer's CVR the 0184 scheme", () => {
    const buyer = buildBuyerParty(null, { ...contact, country: "DK", taxId: "12345678" })
    expect(buyer.vatId).toBe("DK12345678")
    expect(buyer.legalId).toEqual({ id: "12345678", scheme: "0184" })
  })

  it("keeps an explicit endpoint even when it is invalid so the export can report it", () => {
    const buyer = buildBuyerParty(null, { ...contact, peppolEndpointId: "123", peppolEndpointScheme: "0184" })
    expect(buyer.electronicAddress).toEqual({ scheme: "0184", id: "123" })
  })

  it("emits the normalized explicit endpoint it validates", () => {
    const buyer = buildBuyerParty(null, {
      ...contact,
      country: "NL",
      peppolEndpointId: " nl123456789b01 ",
      peppolEndpointScheme: "9944",
    })
    expect(buyer.electronicAddress).toEqual({ scheme: "9944", id: "NL123456789B01" })
  })

  it("keeps a known-scheme legal identifier with a bad checksum so the export can report it", () => {
    expect(legalIdentifier([{ scheme: "gln", value: "5790000000001" }], "NL", null)).toEqual({
      id: "5790000000001",
      scheme: "0088",
    })
    expect(legalIdentifier([{ scheme: "gln", value: "579 0000 000005" }], "NL", null)).toEqual({
      id: "5790000000005",
      scheme: "0088",
    })
    // A malformed CVR is reported rather than silently dropped.
    expect(legalIdentifier([{ scheme: "cvr", value: "1234" }], "DK", null)).toEqual({ id: "1234", scheme: "0184" })
  })

  it("prefers a valid legal identifier over an invalid one", () => {
    expect(
      legalIdentifier(
        [
          { scheme: "gln", value: "5790000000001" },
          { scheme: "duns", value: "123456789" },
        ],
        "NL",
        null
      )
    ).toMatchObject({ id: "123456789", scheme: "0060" })
    // A Danish CVR derived from the VAT number wins over a malformed CVR tax ID.
    expect(legalIdentifier([{ scheme: "cvr", value: "1234" }], "DK", "DK12345678")).toMatchObject({
      id: "12345678",
      scheme: "0184",
    })
  })
})
