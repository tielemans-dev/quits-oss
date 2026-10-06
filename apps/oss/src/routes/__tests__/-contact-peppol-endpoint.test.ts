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
})
