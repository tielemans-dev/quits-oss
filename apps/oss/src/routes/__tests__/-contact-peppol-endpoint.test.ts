import { describe, expect, it } from "vitest"
import { readPeppolEndpoint } from "../_app/contacts/-peppol-endpoint"

function form(id: string, scheme: string) {
  const data = new FormData()
  data.set("peppolEndpointId", id)
  data.set("peppolEndpointScheme", scheme)
  return data
}

describe("contact Peppol endpoint fields", () => {
  it("turns two empty fields into an explicit clear", () => {
    expect(readPeppolEndpoint(form("", " "))).toEqual({
      ok: true,
      peppolEndpointId: null,
      peppolEndpointScheme: null,
    })
  })

  it("accepts a valid endpoint", () => {
    expect(readPeppolEndpoint(form(" 12345678 ", "0184"))).toEqual({
      ok: true,
      peppolEndpointId: "12345678",
      peppolEndpointScheme: "0184",
    })
  })

  it("explains incomplete and invalid endpoints", () => {
    expect(readPeppolEndpoint(form("12345678", ""))).toEqual({
      ok: false,
      error: "exports.contact.peppolEndpoint.incomplete",
    })
    expect(readPeppolEndpoint(form("12345678", "1234"))).toEqual({
      ok: false,
      error: "exports.contact.peppolEndpointScheme.invalid",
    })
    expect(readPeppolEndpoint(form("1234", "0184"))).toEqual({
      ok: false,
      error: "exports.contact.peppolEndpointId.invalid",
    })
  })

  it("saves the normalized identifier the e-invoice export emits", () => {
    expect(readPeppolEndpoint(form(" nl123456789b01 ", "9944"))).toEqual({
      ok: true,
      peppolEndpointId: "NL123456789B01",
      peppolEndpointScheme: "9944",
    })
  })

  it("rejects identifiers that break the PEPPOL-COMMON rules", () => {
    expect(readPeppolEndpoint(form("NL12", "9944"))).toEqual({
      ok: false,
      error: "exports.contact.peppolEndpointId.invalid",
    })
    expect(readPeppolEndpoint(form("123456789", "0192"))).toEqual({
      ok: false,
      error: "exports.contact.peppolEndpointId.invalid",
    })
  })
})
