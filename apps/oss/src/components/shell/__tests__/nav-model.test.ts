import { describe, expect, it } from "vitest"

import { isNavItemActive, navGroups, visibleNavGroups } from "../nav-model"

const pathsOf = (billingEnabled: boolean) =>
  visibleNavGroups(billingEnabled).flatMap((group) => group.items.map((item) => item.path))

describe("navigation model", () => {
  it("keeps every destination the flat sidebar had", () => {
    expect(pathsOf(true).sort()).toEqual(
      [
        "/",
        "/invoices",
        "/credit-notes",
        "/recurring",
        "/agreements",
        "/quotes",
        "/contacts",
        "/approvals",
        "/billing",
        "/settings",
        "/catalog",
      ].sort()
    )
  })

  it("drops Billing where billing is off, and nothing else", () => {
    expect(pathsOf(false)).not.toContain("/billing")
    expect(pathsOf(false)).toHaveLength(pathsOf(true).length - 1)
  })

  it("lists each page once", () => {
    const all = navGroups.flatMap((group) => group.items.map((item) => item.path))
    expect(new Set(all).size).toBe(all.length)
  })

  it("marks a page and the pages below it as current, but not a page that merely shares a prefix", () => {
    const invoices = { path: "/invoices", labelKey: "nav.invoices" } as const
    expect(isNavItemActive(invoices, "/invoices")).toBe(true)
    expect(isNavItemActive(invoices, "/invoices/inv_1")).toBe(true)
    expect(isNavItemActive(invoices, "/invoices-archive")).toBe(false)
    expect(isNavItemActive({ path: "/", labelKey: "nav.dashboard" }, "/invoices")).toBe(false)
  })
})
