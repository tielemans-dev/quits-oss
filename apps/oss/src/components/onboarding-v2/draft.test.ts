import { afterEach, expect, it, vi } from "vitest"
import { cvrCompanySchema } from "@quits/contracts/cvr"
import { confirmOnboardingV2Schema } from "@quits/contracts/onboarding"
import { confirmationPayload, draftSchema, newDraft, registryEmail, registryPhone } from "./draft"

afterEach(() => vi.useRealTimers())

it("uses the current Danish year for each fresh screen draft across midnight", () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date("2026-12-31T22:59:59.999Z"))
  expect(newDraft(null, "synthetic@example.test", false).values.invoicePrefix).toBe("2026")
  vi.setSystemTime(new Date("2026-12-31T23:00:00.000Z"))
  expect(newDraft(null, "synthetic@example.test", false).values.invoicePrefix).toBe("2027")
})

const cvrCompany = { cvr: "24256790", name: "Synthetic Studio ApS", address: "Testvej 1", companyForm: "ApS", status: "active", statusClass: "active" } as const

it("keeps an unknown CVR VAT status unanswered instead of assuming registration", () => {
  const draft = newDraft({ ...cvrCompany, momsRegistered: null }, "synthetic@example.test", false)
  expect(draft.values.momsRegistered).toBeNull()
  expect(draftSchema.parse(draft).values.momsRegistered).toBeNull()
  expect(() => confirmationPayload(draft)).toThrow("VAT status must be confirmed")
  draft.values.momsRegistered = false
  expect(confirmationPayload(draft)).toMatchObject({ momsRegistered: false, settings: { taxRate: 0 } })
})

it("still uses known CVR VAT facts and defaults manual setup to registered", () => {
  expect(newDraft({ ...cvrCompany, momsRegistered: false }, "s@example.test", false).values).toMatchObject({ momsRegistered: false, taxRate: 0 })
  expect(newDraft({ ...cvrCompany, momsRegistered: true }, "s@example.test", false).values).toMatchObject({ momsRegistered: true, taxRate: 25 })
  expect(newDraft(null, "s@example.test", false).values.momsRegistered).toBe(true)
})

it("accepts null (unknown) VAT status in the CVR company contract", () => {
  expect(cvrCompanySchema.parse({ ...cvrCompany, momsRegistered: null }).momsRegistered).toBeNull()
  expect(() => cvrCompanySchema.parse({ ...cvrCompany, momsRegistered: undefined })).toThrow()
})

it("saves only explicitly selected lines and treats older restored drafts as unaccepted", () => {
  const draft = newDraft({ ...cvrCompany, industryCode: "620100", momsRegistered: true }, "s@example.test", true)
  expect(confirmationPayload(draft)).not.toHaveProperty("catalogSuggestions")
  draft.acceptedLineIds = [draft.suggestions!.lines[0].id]
  expect(confirmationPayload(draft).catalogSuggestions?.map(row => row.name)).toEqual(["Softwareudvikling"])
  const { acceptedLineIds: _ids, ...legacy } = draft
  expect(confirmationPayload(draftSchema.parse(legacy))).not.toHaveProperty("catalogSuggestions")
  expect(confirmationPayload({ ...draft, suggestionsState: "hidden" })).not.toHaveProperty("catalogSuggestions")
  draft.suggestions!.lines = []
  expect(confirmationPayload(draft).catalogSuggestions).toEqual([])
})

it("drops register placeholders from the prefill so optional contacts never block confirmation", () => {
  const draft = newDraft({ ...cvrCompany, momsRegistered: false, email: "qa@example.invalid", phone: "00000000" }, "s@example.test", false)
  expect(draft.values).toMatchObject({ companyEmail: "s@example.test", companyPhone: "" })
  expect(confirmOnboardingV2Schema.safeParse(confirmationPayload(draft)).success).toBe(true)
  expect(newDraft({ ...cvrCompany, momsRegistered: true, email: "kontakt@nordlys.dk", phone: "+45 98 12 34 56" }, "s@example.test", false).values)
    .toMatchObject({ companyEmail: "kontakt@nordlys.dk", companyPhone: "+45 98 12 34 56" })
})

it.each(["qa@example.invalid", "a@example.com", "a@mail.example.org", "a@example.dk", "a@firma.test", "a@firma.example", "a@localhost", "a@x.localhost", "not-an-email"])("drops reserved or invalid register email %s", email => {
  expect(registryEmail(email)).toBeNull()
})

it.each(["00000000", "0000 0000", "11111111", "1234", "+45 0000 0000", "004500000000", "+46 12345678"])("drops placeholder or invalid register phone %s", phone => {
  expect(registryPhone(phone)).toBeNull()
})
