import { describe, expect, it, vi } from "vitest"
import { affectedQueries, notifyMutation, subscribeQueryRefresh } from "../query-refresh"

describe("mutation query dependencies", () => {
  it.each(["createV2", "updateV2", "send", "delete", "markPaid", "undoMarkPaid"])("refreshes invoice readers after %s", action => {
    expect(affectedQueries(`invoices.${action}`)).toEqual(expect.arrayContaining(["invoices", "dashboard", "activity", "agents"]))
  })
  it.each([
    ["quotes.convertToInvoice", ["quotes", "invoices", "dashboard"]],
    ["creditNotes.issue", ["creditNotes", "invoices", "dashboard"]],
    ["contacts.update", ["contacts", "invoices", "quotes", "agreements", "recurring"]],
    ["payments.recordReceipt", ["payments", "invoices", "dashboard", "activity"]],
    ["paymentDetails.update", ["settings", "invoices", "dashboard"]],
    ["catalog.archive", ["catalog"]],
    ["agreements.createDraftDecimal", ["agreements", "quotes", "invoices"]],
    ["recurring.runNow", ["recurring", "invoices", "dashboard"]],
    ["agents.decide", ["agents", "invoices", "quotes", "creditNotes", "agreements", "recurring", "dashboard"]],
    ["settings.update", ["settings", "runtime", "invoices", "quotes", "dashboard"]],
    ["jobs.release", ["jobs", "invoices", "dashboard"]],
  ])("maps %s centrally", (path, keys) => {
    expect(affectedQueries(path)).toEqual(expect.arrayContaining(keys))
  })
  it("does not refresh unrelated catalog readers for an invoice payment", () => {
    const catalog = vi.fn(), invoices = vi.fn(), otherOrganization = vi.fn()
    const stop = [subscribeQueryRefresh(["catalog"], "a", catalog), subscribeQueryRefresh(["invoices"], "a", invoices), subscribeQueryRefresh(["invoices"], "b", otherOrganization)]
    notifyMutation("invoices.markPaid", "a")
    expect(invoices).toHaveBeenCalledOnce()
    expect(catalog).not.toHaveBeenCalled()
    expect(otherOrganization).not.toHaveBeenCalled()
    stop.forEach(unsubscribe => unsubscribe())
    notifyMutation("invoices.markPaid", "a")
    expect(invoices).toHaveBeenCalledOnce()
  })
})
