// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest"
const context = vi.hoisted(() => ({ organizationId: "org-a" }))
vi.mock("../active-organization", () => ({ getRequestOrganizationId: () => context.organizationId }))
import { retainDraftValuation, readDraftValuation, clearDraftValuation } from "../invoice-issuance-draft"
const value = { exchangeRate: "7.456789", rateDate: "2026-10-02" }
beforeEach(() => { sessionStorage.clear(); context.organizationId = "org-a" })
it("isolates retained inputs by organization, invoice and currency pair", () => {
  retainDraftValuation("draft", "EUR", "DKK", value)
  expect(readDraftValuation("draft", "EUR", "DKK")).toEqual(value)
  expect(readDraftValuation("other", "EUR", "DKK")).toBeUndefined()
  expect(readDraftValuation("draft", "USD", "DKK")).toBeUndefined()
  expect(readDraftValuation("draft", "EUR", "USD")).toBeUndefined()
  expect(readDraftValuation("draft", "DKK", "DKK")).toBeUndefined()
  context.organizationId = "org-b"
  expect(readDraftValuation("draft", "EUR", "DKK")).toBeUndefined()
  context.organizationId = "org-a"
  clearDraftValuation("draft", "EUR", "DKK")
  expect(readDraftValuation("draft", "EUR", "DKK")).toBeUndefined()
})
it("restores a tab's retained inputs even with a fresh module instance", async () => {
  retainDraftValuation("reload", "EUR", "DKK", value)
  vi.resetModules()
  const fresh = await import("../invoice-issuance-draft")
  expect(fresh.readDraftValuation("reload", "EUR", "DKK")).toEqual(value)
  fresh.clearDraftValuation("reload", "EUR", "DKK")
  clearDraftValuation("reload", "EUR", "DKK")
})
it("keeps navigation usable if session storage is disabled", () => {
  const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage disabled") })
  retainDraftValuation("blocked", "EUR", "DKK", value)
  expect(readDraftValuation("blocked", "EUR", "DKK")).toEqual(value)
  clearDraftValuation("blocked", "EUR", "DKK")
  expect(readDraftValuation("blocked", "EUR", "DKK")).toBeUndefined()
  write.mockRestore()
})
