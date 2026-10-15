import { afterEach, expect, it, vi } from "vitest"
import { cvrCompanySchema } from "@quits/contracts/cvr"
import { confirmationPayload, draftSchema, newDraft } from "./draft"

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
