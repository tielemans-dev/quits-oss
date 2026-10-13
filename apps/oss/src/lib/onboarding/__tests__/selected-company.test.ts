// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest"
import { clearSelectedCompany, readSelectedCompany, stageSelectedCompany } from "../selected-company"

afterEach(() => {
  sessionStorage.clear()
})

describe("selected company handoff", () => {
  it("keeps a confirmed CVR company and a typed name", () => {
    stageSelectedCompany("user", "org", { name: "Nordlys Studio ApS", address: "Vestergade 1", cvr: "12345678" })
    expect(readSelectedCompany("user", "org")).toEqual({ name: "Nordlys Studio ApS", address: "Vestergade 1", cvr: "12345678" })

    clearSelectedCompany("user", "org")
    stageSelectedCompany("user", "org", { name: "  Nordic Advisory  " })
    expect(readSelectedCompany("user", "org")).toEqual({ name: "Nordic Advisory", address: "", cvr: "" })
  })

  it("drops a malformed record", () => {
    sessionStorage.setItem("quits:onboarding:selected-company:v1:user:org", JSON.stringify({ name: "Acme", address: "", cvr: "12" }))
    expect(readSelectedCompany("user", "org")).toBeNull()
    expect(sessionStorage.getItem("quits:onboarding:selected-company:v1:user:org")).toBeNull()
  })
})
