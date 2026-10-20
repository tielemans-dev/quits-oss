import { describe, expect, it } from "vitest"
import { contactSaveError } from "../_app/contacts/-contact-save-error"

const t = (key: string) => `t:${key}`

describe("contactSaveError", () => {
  it("translates a rejected phone number", () => {
    const error = Object.assign(new Error("Phone number format does not match selected country."), {
      data: { issues: [{ path: "phone", message: "Phone number format does not match selected country." }] },
    })
    expect(contactSaveError(error, t, "contacts.new.error.createFailed")).toBe("t:validation.phone.invalid")
  })

  it("keeps other server messages and falls back for unknown failures", () => {
    const error = Object.assign(new Error("Postal code format does not match selected country."), {
      data: { issues: [{ path: "postalCode", message: "Postal code format does not match selected country." }] },
    })
    expect(contactSaveError(error, t, "contacts.new.error.createFailed")).toBe(error.message)
    expect(contactSaveError("boom", t, "contacts.edit.error.updateFailed")).toBe("t:contacts.edit.error.updateFailed")
  })
})
