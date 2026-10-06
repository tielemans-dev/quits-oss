import { describe, expect, it } from "vitest"
import { buildBuyerParty, buildSellerParty } from "../einvoice"

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
      companyId: "12345678",
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
})
