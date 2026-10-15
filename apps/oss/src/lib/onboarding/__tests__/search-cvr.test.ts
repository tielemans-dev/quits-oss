import { describe, expect, it, vi } from "vitest"
import { searchOwnCvr, type CvrLookupProvider } from "../search-cvr"

const company = {
  cvr: "24256790",
  name: " Nordlys Studio ApS ",
  address: " Vestergade 1 ",
  status: "active", statusClass: "active",
}

describe("searchOwnCvr", () => {
  it("stays closed without a hosted lookup provider", async () => {
    const lookup: CvrLookupProvider = { search: vi.fn() }
    await expect(searchOwnCvr({ query: "Nordlys", cloud: false, userId: "user_1", lookup })).resolves.toEqual({
      available: false,
      companies: [],
    })
    await expect(searchOwnCvr({ query: "Nordlys", cloud: true, userId: "user_1" })).resolves.toEqual({
      available: false,
      companies: [],
    })
    expect(lookup.search).not.toHaveBeenCalled()
  })

  it("returns the confirmed company facts from the hosted lookup", async () => {
    const lookup: CvrLookupProvider = {
      search: vi.fn(async () => [company, { ...company, cvr: "12", name: "Bad", address: "" }, { ...company, status: "ceased", statusClass: "blocked" }]),
    }
    await expect(searchOwnCvr({ query: "Nordlys", cloud: true, userId: "user_1", lookup })).resolves.toEqual({
      available: true,
      companies: [{ cvr: "24256790", name: "Nordlys Studio ApS", address: "Vestergade 1" }],
    })
  })
})
