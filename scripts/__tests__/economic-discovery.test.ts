import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { CONTRACT_FIELDS, INPUT_FIELDS, validateDocumentedPaths, validateMatrix, type Matrix, type Snapshot } from "../economic-discovery/matrix.ts"
import { exponentFor, normalizeEconomic, toMinor } from "../economic-discovery/normalize.ts"
import type { ImportBundle, SourceBundle } from "../economic-discovery/types.ts"

const dir = fileURLToPath(new URL("../../docs/migration/economic/", import.meta.url))
const readJson = <T>(file: string): T => JSON.parse(readFileSync(dir + file, "utf8")) as T

type Expect = {
  documents: Record<string, { kind: string; gross: number; currency: string; residual: number; residualBasis: string; pdf: string; attachments: number }>
  ledgerItems: Record<string, { kind: string; residual: number }>
  allocations: { debitEntry: number; creditEntry: number; amount: number }[]
  clusters: { entries: number[]; status: string }[]
  exceptions: { code: string; severity: string; subject: string }[]
  allRowsMatch: boolean
  rowKinds: string[]
  excluded?: string[]
  controlDiffBase?: number
  controlBalanceBase?: number
}
type Scenario = { name: string; description: string; source: SourceBundle; expect: Expect }
const fixtures = readJson<{ synthetic: true; scenarios: Scenario[] }>("fixtures/synthetic-scenarios.json")
const snapshot = readJson<Snapshot>("api-snapshot.json")
const matrix = readJson<Matrix>("extraction-matrix.json")

const byName = (name: string) => fixtures.scenarios.find((s) => s.name === name)!
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T
const codes = (b: ImportBundle) => b.exceptions.map((e) => `${e.code}@${e.subject}`).sort()

describe("e-conomic synthetic fixtures", () => {
  it("are marked synthetic everywhere and cover every required scenario", () => {
    expect(fixtures.synthetic).toBe(true)
    for (const s of fixtures.scenarios) expect(s.source.synthetic).toBe(true)
    for (const required of [
      "unpaid", "fully_paid", "partially_paid", "credit_allocation", "unapplied_cash", "rounding",
      "foreign_currency", "missing_documents",
    ]) {
      expect(fixtures.scenarios.map((s) => s.name)).toContain(required)
    }
  })

  for (const scenario of fixtures.scenarios) {
    describe(scenario.name, () => {
      const out = normalizeEconomic(scenario.source)
      const want = scenario.expect

      it("maps documents with their residuals, basis and artifacts", () => {
        expect(out.documents.map((d) => d.sourceKey).sort()).toEqual(Object.keys(want.documents).sort())
        for (const d of out.documents) {
          const w = want.documents[d.sourceKey]!
          expect({ kind: d.kind, gross: d.gross, currency: d.currency, residual: d.sourceResidual, basis: d.residualBasis, pdf: d.originalPdf.status, attachments: d.attachedDocumentNumbers.length })
            .toEqual({ kind: w.kind, gross: w.gross, currency: w.currency, residual: w.residual, basis: w.residualBasis, pdf: w.pdf, attachments: w.attachments })
        }
      })

      it("maps non-document ledger items", () => {
        expect(out.ledgerItems.map((i) => i.sourceKey).sort()).toEqual(Object.keys(want.ledgerItems).sort())
        for (const i of out.ledgerItems) {
          expect({ kind: i.kind, residual: i.sourceResidual }).toEqual(want.ledgerItems[i.sourceKey])
        }
      })

      it("solves allocations from matched pairs and reports what it cannot solve", () => {
        const sort = <T extends { debitEntry: number; creditEntry: number }>(a: T[]) => [...a].sort((x, y) => x.debitEntry - y.debitEntry || x.creditEntry - y.creditEntry)
        expect(sort(out.allocations.map((a) => ({ debitEntry: a.debitEntry, creditEntry: a.creditEntry, amount: a.amount })))).toEqual(sort(want.allocations))
        const key = (c: { entries: number[]; status: string }) => `${[...c.entries].sort((x, y) => x - y).join(",")}:${c.status}`
        expect(out.clusters.map(key).sort()).toEqual(want.clusters.map(key).sort())
      })

      it("reports exactly the expected exceptions", () => {
        expect(codes(out)).toEqual(want.exceptions.map((e) => `${e.code}@${e.subject}`).sort())
        for (const e of want.exceptions) {
          expect(out.exceptions.find((x) => x.code === e.code && x.subject === e.subject)?.severity).toBe(e.severity)
        }
      })

      it("reconciles residuals per customer, document and currency", () => {
        expect(out.reconciliation.allRowsMatch).toBe(want.allRowsMatch)
        expect(out.reconciliation.rows.map((r) => r.kind).sort()).toEqual([...want.rowKinds].sort())
        expect(out.excludedAfterCutover).toEqual(want.excluded ?? [])
        for (const row of out.reconciliation.rows) {
          if (row.match === false) expect(want.allRowsMatch).toBe(false)
          if (row.recomputedResidual == null) expect(row.match).toBeNull()
        }
        const c = out.reconciliation.customerControls[0]!
        if (want.controlDiffBase != null) expect(c.differenceBase).toBe(want.controlDiffBase)
        else expect(Math.abs(c.differenceBase ?? 0)).toBeLessThanOrEqual(c.toleranceBase)
        if (want.controlBalanceBase != null) expect(c.ledgerResidualBase).toBe(want.controlBalanceBase)
      })
    })
  }
})

describe("allocation proof, not a paid flag", () => {
  it("blocks a fully paid match across two known customers even when both controls balance", () => {
    const s = clone(byName("fully_paid").source)
    s.entries.find((e) => e.type === 2)!.customerNumber = 2
    s.customers.push({ ...s.customers[0]!, customerNumber: 2, name: "Other customer", balance: 0 })
    const out = normalizeEconomic(s)
    expect(out.reconciliation.customerControls.map((c) => c.differenceBase)).toEqual([0, 0])
    expect(out.exceptions.some((e) => e.code === "contact_unknown")).toBe(false)
    expect(out.exceptions).toContainEqual(expect.objectContaining({ code: "cluster_customer_mixed", severity: "blocking", subject: "cluster:1" }))
    expect(out.clusters[0]!.status).toBe("inconsistent")
    expect(out.allocations).toEqual([])
    expect(out.documents[0]).toMatchObject({ contactSourceId: "customer:1", sourceResidual: 0, recomputedResidual: null, residualBasis: "source_remainder_only" })
    expect(out.ledgerItems[0]).toMatchObject({ contactSourceId: "customer:2", sourceResidual: 0 })
    expect(out.reconciliation.rows).toEqual([
      expect.objectContaining({ contactSourceId: "customer:1", sourceResidual: 0, recomputedResidual: null, match: null }),
      expect.objectContaining({ contactSourceId: "customer:2", sourceResidual: 0, recomputedResidual: null, match: null }),
    ])
    expect(out.reconciliation.allRowsMatch).toBe(false)
  })

  it("blocks equal numeric invoice and ledger amounts in different currencies", () => {
    const s = clone(byName("unpaid").source)
    s.bookedInvoices[0]!.currency = "EUR"
    const out = normalizeEconomic(s)
    expect(out.exceptions).toContainEqual(expect.objectContaining({ code: "debtor_line_currency_mismatch", severity: "blocking", subject: "invoice:1001" }))
    expect(out.exceptions.some((e) => e.code === "debtor_line_amount_mismatch" || e.code === "remainder_disagreement")).toBe(false)
    expect(out.documents[0]!.recomputedResidual).toBeNull()
    expect(out.documents[0]!.residualBasis).toBe("source_remainder_only")
    expect(out.reconciliation.rows[0]!.match).toBeNull()
    expect(out.reconciliation.allRowsMatch).toBe(false)
  })

  it("uses the base currency for a debtor line with no currency code", () => {
    const s = clone(byName("unpaid").source)
    delete s.entries.find((e) => e.customerNumber != null)!.currencyCode
    expect(normalizeEconomic(s).exceptions).toEqual([])
    expect(normalizeEconomic(s).reconciliation.allRowsMatch).toBe(true)
    s.bookedInvoices[0]!.currency = "EUR"
    expect(normalizeEconomic(s).exceptions.some((e) => e.code === "debtor_line_currency_mismatch")).toBe(true)
  })

  it("does not reconcile zero residuals or emit allocations for a paid invoice in the wrong currency", () => {
    const s = clone(byName("fully_paid").source)
    s.bookedInvoices[0]!.currency = "EUR"
    const out = normalizeEconomic(s)
    expect(out.exceptions.some((e) => e.code === "debtor_line_currency_mismatch" && e.severity === "blocking")).toBe(true)
    expect(out.allocations).toEqual([])
    expect(out.documents[0]!.recomputedResidual).toBeNull()
    expect(out.reconciliation.allRowsMatch).toBe(false)
  })

  it("does not compare minor units when the invoice and ledger have different exponents", () => {
    const s = clone(byName("unpaid").source)
    s.bookedInvoices[0]!.currency = "JPY"
    const out = normalizeEconomic(s)
    expect(out.exceptions.map((e) => e.code)).toEqual(["debtor_line_currency_mismatch"])
    expect(out.documents[0]!.recomputedResidual).toBeNull()
    expect(out.reconciliation.allRowsMatch).toBe(false)
  })

  it("checks every debtor line's currency before summing residuals", () => {
    const s = clone(byName("unpaid").source)
    const debtor = s.entries.find((e) => e.customerNumber != null)!
    const other = { ...debtor, entryNumber: 99, currencyCode: "EUR", amount: 250, remainder: 250, amountInBaseCurrency: 250 }
    debtor.amount = debtor.remainder = debtor.amountInBaseCurrency = 1000
    s.entries.push(other)
    const out = normalizeEconomic(s)
    expect(out.exceptions.some((e) => e.code === "debtor_line_currency_mismatch" && e.severity === "blocking")).toBe(true)
    expect(out.documents[0]!.recomputedResidual).toBeNull()
    expect(out.reconciliation.allRowsMatch).toBe(false)
  })

  it("never reads a zero remainder as a payment: no pair means unsupported history", () => {
    const out = normalizeEconomic(byName("unsupported_history").source)
    expect(out.allocations).toEqual([])
    expect(out.exceptions.filter((e) => e.code === "applied_without_match_pair")).toHaveLength(2)
    expect(out.reconciliation.allRowsMatch).toBe(false)
  })

  it("takes the applied amount from amount minus remainder, not from the pair amounts", () => {
    const out = normalizeEconomic(byName("partially_paid").source)
    const pair = byName("partially_paid").source.matchedPairs[0]!
    expect(Math.abs(pair.fromEntryAmount)).toBe(1000)
    expect(out.allocations).toHaveLength(1)
    expect(out.allocations[0]!.amount).toBe(40000)
  })

  it("joins invoice, ledger line and attachment by invoice number, voucher and accounting year", () => {
    const out = normalizeEconomic(byName("unpaid").source)
    const d = out.documents[0]!
    expect(d.ledgerEntryNumbers).toHaveLength(1)
    expect(d.voucherNumber).toBe(1)
    expect(d.accountingYear).toBe("2026")
    expect(d.attachedDocumentNumbers).toHaveLength(1)
  })

  it("does not attach a document from another accounting year with the same voucher number", () => {
    const s = clone(byName("unpaid").source)
    s.attachedDocuments[0]!.accountingYear = "2025"
    expect(normalizeEconomic(s).documents[0]!.attachedDocumentNumbers).toEqual([])
  })

  it("blocks when a REST remainder disagrees with the ledger line", () => {
    const s = clone(byName("partially_paid").source)
    s.bookedInvoices[0]!.remainder = 0
    const out = normalizeEconomic(s)
    expect(out.exceptions.map((e) => e.code)).toContain("remainder_disagreement")
    expect(out.reconciliation.allRowsMatch).toBe(false)
  })

  it("blocks when a pair points at an entry that was not extracted", () => {
    const s = clone(byName("fully_paid").source)
    s.entries = s.entries.filter((e) => e.type !== 2)
    const out = normalizeEconomic(s)
    expect(out.exceptions.some((e) => e.code === "pair_references_unknown_entry" && e.severity === "blocking")).toBe(true)
    expect(out.clusters[0]!.status).toBe("inconsistent")
    expect(out.allocations).toEqual([])
  })

  for (const endpoint of ["fromEntryAmount", "toEntryAmount"] as const) {
    for (const [delta, code] of [[1, "pair_references_unknown_entry"], [0.001, "sub_minor_precision"]] as const) {
      for (const traversal of ["original", "repeated", "reversed"] as const) {
        it(`keeps residuals source-only for an invalid ${endpoint} (${code}) in the ${traversal} pair`, () => {
          const s = clone(byName("fully_paid").source)
          const pair = s.matchedPairs[0]!
          const invalid = traversal === "reversed" ? {
            fromEntry: pair.toEntry, fromEntryDate: pair.toEntryDate, fromEntryAmount: pair.toEntryAmount, fromEntryAmountDKK: pair.toEntryAmountDKK,
            toEntry: pair.fromEntry, toEntryDate: pair.fromEntryDate, toEntryAmount: pair.fromEntryAmount, toEntryAmountDKK: pair.fromEntryAmountDKK,
          } : clone(pair)
          invalid[endpoint] += delta
          if (traversal === "original") s.matchedPairs = [invalid]
          else s.matchedPairs.push(invalid)
          const out = normalizeEconomic(s)
          expect(out.exceptions).toContainEqual(expect.objectContaining({ code, severity: "blocking" }))
          expect(out.clusters).toEqual([expect.objectContaining({ entries: [3, 4], status: "inconsistent" })])
          expect(out.allocations).toEqual([])
          expect(out.documents[0]).toMatchObject({ sourceResidual: 0, recomputedResidual: null, residualBasis: "source_remainder_only" })
          expect(out.ledgerItems[0]!.sourceResidual).toBe(0)
          expect(out.reconciliation.rows).toEqual([
            expect.objectContaining({ documentKey: "invoice:1002", sourceResidual: 0, recomputedResidual: null, match: null }),
            expect.objectContaining({ documentKey: null, sourceResidual: 0, recomputedResidual: null, match: null }),
          ])
          expect(out.reconciliation.allRowsMatch).toBe(false)
        })
      }
    }
  }

  it("flags a ledger line whose invoice was not extracted", () => {
    const s = clone(byName("unpaid").source)
    s.bookedInvoices = []
    expect(normalizeEconomic(s).exceptions.some((e) => e.code === "ledger_entry_without_invoice")).toBe(true)
  })

  it("flags a booked invoice with no customer-ledger line", () => {
    const s = clone(byName("unpaid").source)
    s.entries = s.entries.filter((e) => e.customerNumber == null)
    expect(normalizeEconomic(s).exceptions.some((e) => e.code === "invoice_without_ledger_entry")).toBe(true)
  })

  it("flags revenue, VAT and debtor lines that do not balance", () => {
    const s = clone(byName("unpaid").source)
    s.entries.find((e) => e.accountNumber === 1010)!.amountInBaseCurrency += 5
    expect(normalizeEconomic(s).exceptions.some((e) => e.code === "invoice_ledger_lines_unbalanced")).toBe(true)
  })

  it("flags totals that do not add up", () => {
    const s = clone(byName("unpaid").source)
    s.bookedInvoices[0]!.vatAmount += 1
    expect(normalizeEconomic(s).exceptions.some((e) => e.code === "invoice_total_mismatch")).toBe(true)
  })

  it("refuses to round away sub-minor precision", () => {
    const s = clone(byName("unpaid").source)
    s.bookedInvoices[0]!.netAmount = 1000.005
    expect(normalizeEconomic(s).exceptions.some((e) => e.code === "sub_minor_precision" && e.severity === "blocking")).toBe(true)
  })

  it("flags a ledger line with no remainder instead of assuming it is open", () => {
    const s = clone(byName("unpaid").source)
    delete s.entries.find((e) => e.customerNumber != null)!.remainder
    expect(normalizeEconomic(s).exceptions.some((e) => e.code === "remainder_missing")).toBe(true)
  })

  it("flags a remainder that exceeds the entry amount", () => {
    const s = clone(byName("unpaid").source)
    s.entries.find((e) => e.customerNumber != null)!.remainder = 9999
    expect(normalizeEconomic(s).exceptions.some((e) => e.code === "remainder_out_of_range")).toBe(true)
  })

  it("flags mixed-currency clusters rather than comparing unlike amounts", () => {
    const s = clone(byName("foreign_currency").source)
    const pay = s.entries.find((e) => e.type === 2)!
    pay.currencyCode = "DKK"
    const out = normalizeEconomic(s)
    expect(out.exceptions.some((e) => e.code === "cluster_currency_mixed")).toBe(true)
  })

  it("reports an unknown currency exponent instead of guessing silently", () => {
    const s = clone(byName("unpaid").source)
    s.bookedInvoices[0]!.currency = "KWD"
    expect(normalizeEconomic(s).exceptions.some((e) => e.code === "currency_exponent_unknown")).toBe(true)
  })

  it("reports a customer that was not extracted", () => {
    const s = clone(byName("unpaid").source)
    s.customers = []
    expect(normalizeEconomic(s).exceptions.some((e) => e.code === "contact_unknown")).toBe(true)
  })
})

describe("source identity validation", () => {
  const collections = ["bookedInvoices", "entries", "customers", "attachedDocuments", "accountingYears"] as const
  for (const collection of collections) {
    for (const conflicting of [false, true]) {
      it(`rejects the whole batch for ${conflicting ? "conflicting" : "identical"} duplicate ${collection}`, () => {
        const s = clone(byName("unpaid").source)
        const duplicate = clone(s[collection][0]!)
        if (conflicting) {
          if ("grossAmount" in duplicate) duplicate.grossAmount += 1
          if ("amount" in duplicate) duplicate.amount += 1
          if ("name" in duplicate) duplicate.name = "Conflicting customer"
          if ("voucherNumber" in duplicate) duplicate.voucherNumber = 99
          if ("fromDate" in duplicate) duplicate.fromDate = "2025-02-01"
        }
        // The collection and duplicate have the same element type at runtime.
        ;(s[collection] as typeof duplicate[]).push(duplicate)
        const out = normalizeEconomic(s)
        expect(out.exceptions).toContainEqual(expect.objectContaining({ code: "duplicate_source_identity", severity: "blocking" }))
        expect(out.contacts).toEqual([])
        expect(out.documents).toEqual([])
        expect(out.ledgerItems).toEqual([])
        expect(out.allocations).toEqual([])
        expect(out.clusters).toEqual([])
        expect(out.reconciliation.rows).toEqual([])
        expect(out.reconciliation.allRowsMatch).toBe(false)
      })
    }
  }

  it("keeps repeated pairs as one edge, including reverse traversal", () => {
    const s = clone(byName("fully_paid").source)
    const pair = s.matchedPairs[0]!
    s.matchedPairs.push(clone(pair), {
      fromEntry: pair.toEntry, fromEntryDate: pair.toEntryDate, fromEntryAmount: pair.toEntryAmount, fromEntryAmountDKK: pair.toEntryAmountDKK,
      toEntry: pair.fromEntry, toEntryDate: pair.fromEntryDate, toEntryAmount: pair.fromEntryAmount, toEntryAmountDKK: pair.fromEntryAmountDKK,
    })
    const out = normalizeEconomic(s)
    expect(out.allocations).toHaveLength(1)
    expect(out.exceptions).toEqual([])
    expect(out.reconciliation.allRowsMatch).toBe(true)
  })

  for (const type of [1, 2]) {
    it(`rejects a duplicated customer-ledger ${type === 1 ? "debtor" : "payment"} before Map overwrite`, () => {
      const s = clone(byName("fully_paid").source)
      s.entries.push(clone(s.entries.find((e) => e.type === type && e.customerNumber != null)!))
      const out = normalizeEconomic(s)
      expect(out.exceptions).toContainEqual(expect.objectContaining({ code: "duplicate_source_identity", severity: "blocking" }))
      expect(out.documents).toEqual([])
      expect(out.ledgerItems).toEqual([])
      expect(out.allocations).toEqual([])
      expect(out.reconciliation.allRowsMatch).toBe(false)
    })
  }
})

describe("allocation import scope", () => {
  const expectRepresentedEndpoints = (out: ImportBundle) => {
    const represented = new Set([...out.documents.flatMap((d) => d.ledgerEntryNumbers), ...out.ledgerItems.map((i) => i.entryNumber)])
    for (const a of out.allocations) {
      expect(represented.has(a.debitEntry)).toBe(true)
      expect(represented.has(a.creditEntry)).toBe(true)
    }
  }

  it("emits only allocations with represented endpoints in every fixture", () => {
    for (const s of fixtures.scenarios) expectRepresentedEndpoints(normalizeEconomic(s.source))
  })

  it("keeps a source-only snapshot for an invoice paid after cutover", () => {
    const out = normalizeEconomic(byName("cutover_boundary").source)
    expect(out.allocations).toEqual([])
    expect(out.documents[0]).toMatchObject({ sourceKey: "invoice:1026", sourceResidual: 0, recomputedResidual: null, residualBasis: "source_remainder_only" })
    expect(out.ledgerItems).toEqual([])
    expect(out.reconciliation.allRowsMatch).toBe(false)
    expect(out.reconciliation.rows[0]!.match).toBeNull()
  })

  it("omits the entire cluster when a pre-cutover payment also pays a later invoice", () => {
    const s = clone(byName("many_to_one").source)
    // A shared payment connects two invoices. Keep its entry date before cutover,
    // but exclude one invoice by its REST issue date.
    const payment = s.entries.find((e) => e.type === 2 && s.matchedPairs.filter((p) => p.fromEntry === e.entryNumber || p.toEntry === e.entryNumber).length > 1)!
    const pair = s.matchedPairs.find((p) => p.fromEntry === payment.entryNumber || p.toEntry === payment.entryNumber)!
    const debtorNumber = pair.fromEntry === payment.entryNumber ? pair.toEntry : pair.fromEntry
    const debtor = s.entries.find((e) => e.entryNumber === debtorNumber)!
    s.bookedInvoices.find((i) => i.bookedInvoiceNumber === debtor.customerInvoiceNumber)!.date = "2026-10-02"
    const out = normalizeEconomic(s)
    expect(out.allocations.some((a) => a.debitEntry === payment.entryNumber || a.creditEntry === payment.entryNumber)).toBe(false)
    expect(out.reconciliation.rows.filter((r) => r.recomputedResidual == null).length).toBeGreaterThanOrEqual(2)
    expect(out.reconciliation.allRowsMatch).toBe(false)
    expectRepresentedEndpoints(out)
  })

  it("keeps both endpoints dated exactly on cutover eligible", () => {
    const s = clone(byName("fully_paid").source)
    s.bookedInvoices[0]!.date = s.extraction.cutoverDate
    for (const e of s.entries) e.date = `${s.extraction.cutoverDate}T00:00:00`
    const out = normalizeEconomic(s)
    expect(out.allocations).toHaveLength(1)
    expect(out.reconciliation.allRowsMatch).toBe(true)
    expectRepresentedEndpoints(out)
  })

  it("keeps a pre-cutover payment source-only when its invoice is excluded", () => {
    const s = clone(byName("fully_paid").source)
    s.bookedInvoices[0]!.date = "2026-10-02"
    const out = normalizeEconomic(s)
    expect(out.documents).toEqual([])
    expect(out.ledgerItems).toHaveLength(1)
    expect(out.allocations).toEqual([])
    expect(out.reconciliation.rows[0]).toMatchObject({ sourceResidual: 0, recomputedResidual: null, match: null })
    expect(out.exceptions).toContainEqual(expect.objectContaining({ code: "snapshot_residual_only", subject: "entry:4", severity: "degraded" }))
    expect(out.reconciliation.allRowsMatch).toBe(false)
    expectRepresentedEndpoints(out)
  })

  it("cannot recompute an earlier document whose debtor entry is dated after cutover", () => {
    const s = clone(byName("unpaid").source)
    s.entries.find((e) => e.customerNumber != null)!.date = "2026-10-02T00:00:00"
    const out = normalizeEconomic(s)
    expect(out.documents[0]!.residualBasis).toBe("source_remainder_only")
    expect(out.documents[0]!.recomputedResidual).toBeNull()
    expect(out.exceptions).toContainEqual(expect.objectContaining({ code: "snapshot_residual_only", subject: "invoice:1001" }))
    expect(out.reconciliation.allRowsMatch).toBe(false)
  })

  it("omits a match to an unsupported ledger item and leaves the document source-only", () => {
    const s = clone(byName("fully_paid").source)
    s.entries.find((e) => e.type === 2)!.type = 6
    const out = normalizeEconomic(s)
    expect(out.allocations).toEqual([])
    expect(out.documents[0]!.recomputedResidual).toBeNull()
    expect(out.exceptions.some((e) => e.code === "snapshot_residual_only")).toBe(true)
    expect(out.reconciliation.allRowsMatch).toBe(false)
    expectRepresentedEndpoints(out)
  })
})

describe("money helpers", () => {
  it("converts to minor units for exponents 0 and 2 and flags excess precision", () => {
    const issues = { add: () => undefined } as unknown as Parameters<typeof toMinor>[2]
    expect(toMinor(1187.5, 2, issues, "x")).toBe(118750)
    expect(toMinor(-0.29, 2, issues, "x")).toBe(-29)
    expect(toMinor(1500, 0, issues, "x")).toBe(1500)
    expect(exponentFor("JPY")).toBe(0)
    expect(exponentFor("DKK")).toBe(2)
  })
})

describe("extraction matrix", () => {
  it("maps every contract field to a documented endpoint field, a derivation, or a stated gap", () => {
    expect(validateMatrix(matrix, snapshot)).toEqual([])
    expect(matrix.rows).toHaveLength(CONTRACT_FIELDS.length + INPUT_FIELDS.length)
  })

  it("only ever cites read (GET) operations, never the matching write", () => {
    for (const r of matrix.rows) {
      if (r.source) {
        expect(r.source.method).toBe("GET")
        expect(r.source.endpoint).not.toBe("/booked-entries/match")
      }
    }
    const writes = snapshot.openapi.BookedEntries.endpoints.filter((e) => e.method !== "GET").map((e) => e.path)
    expect(writes).toEqual(["/booked-entries/match"])
  })

  it("records the unsupported cases the importer must surface", () => {
    const unsupported = matrix.rows.filter((r) => r.status === "unsupported").map((r) => r.contractField).sort()
    expect(unsupported).toEqual(["allocation.fxDifference", "allocation.matchedAt", "document.correctsInvoice", "document.vatTreatment", "extraction.cutover", "ledgerItem.paymentMethod"])
  })

  it("rejects a row that cites an undocumented field, endpoint or role", () => {
    const bad = clone(matrix)
    bad.rows.find((r) => r.contractField === "document.gross")!.source!.field = "totalWithTax"
    bad.rows.find((r) => r.contractField === "ledgerItem.amount")!.source!.endpoint = "/booked-entries/export"
    bad.rows.find((r) => r.contractField === "contact.name")!.source!.requiredRoles = ["Bookkeeping"]
    bad.rows = bad.rows.filter((r) => r.contractField !== "allocation.amount")
    const problems = validateMatrix(bad, snapshot).join("\n")
    expect(problems).toContain("document.gross: REST /invoices/booked/:bookedInvoiceNumber has no documented field totalWithTax")
    expect(problems).toContain("ledgerItem.amount")
    expect(problems).toContain("contact.name: roles Bookkeeping differ")
    expect(problems).toContain("allocation.amount: contract field has no matrix row")
  })

  it("keeps the Sales-only and Bookkeeping-only surfaces apart", () => {
    const rest = new Set(matrix.rows.filter((r) => r.source?.api === "rest").flatMap((r) => r.source!.requiredRoles))
    const entries = new Set(matrix.rows.filter((r) => r.source && r.source.api !== "rest").flatMap((r) => r.source!.requiredRoles))
    expect([...rest].sort()).toEqual(["Bookkeeping", "Sales", "SuperUser"])
    expect([...entries].sort()).toEqual(["Bookkeeping", "SuperUser"])
  })
})

describe("fixtures use only documented field names", () => {
  it("matches the documentation snapshot for every payload", () => {
    const customers = snapshot.rest["/customers"]!.fields
    const invoices = snapshot.rest["/invoices/booked/:bookedInvoiceNumber"]!.fields
    const entry = snapshot.openapi.BookedEntries.schemas.BookedEntry!
    const pair = snapshot.openapi.BookedEntries.schemas.MatchedBookedEntriesPair!
    const attached = snapshot.openapi.Documents.schemas.AttachedDocument!
    const years = snapshot.rest["/accounting-years"]!.fields
    const unknown: string[] = []
    const check = (label: string, obj: object, allowed: string[]) => {
      unknown.push(...validateDocumentedPaths(obj, allowed).map((path) => `${label}.${path}`))
    }
    for (const s of fixtures.scenarios) {
      s.source.customers.forEach((c) => check("customer", c, customers))
      s.source.bookedInvoices.forEach((i) => check("bookedInvoice", i, invoices))
      s.source.entries.forEach((e) => check("entry", e, entry))
      s.source.matchedPairs.forEach((p) => check("pair", p, pair))
      s.source.attachedDocuments.forEach((a) => check("attachedDocument", a, attached))
      s.source.accountingYears.forEach((y) => check("accountingYear", y, years))
    }
    expect(unknown).toEqual([])
  })

  it("pins the API versions the snapshot was taken from", () => {
    expect(snapshot.openapi.BookedEntries.version).toBe("6.0.0")
    expect(snapshot.openapi.Documents.version).toBe("4.0.1")
    for (const s of fixtures.scenarios) {
      expect(s.source.extraction.apiVersions.bookedEntries).toBe(snapshot.openapi.BookedEntries.version)
      expect(s.source.extraction.apiVersions.documents).toBe(snapshot.openapi.Documents.version)
    }
  })
})


describe("historical bot regressions", () => {
  for (const omitted of [false, true]) {
    it(`blocks a debtor with ${omitted ? "omitted" : "null"} invoice identity without inventing a document`, () => {
      const s = clone(byName("unpaid").source)
      s.bookedInvoices = []
      s.entries = s.entries.filter((e) => e.customerNumber != null)
      if (omitted) delete s.entries[0]!.customerInvoiceNumber
      else s.entries[0]!.customerInvoiceNumber = null
      const out = normalizeEconomic(s)
      expect(out.exceptions).toContainEqual(expect.objectContaining({ code: "ledger_entry_without_invoice", severity: "blocking", subject: `entry:${s.entries[0]!.entryNumber}` }))
      expect(out.documents).toEqual([])
      expect(out.ledgerItems).toEqual([])
      expect(out.reconciliation.customerControls[0]!.ledgerResidualBase).toBe(125000)
      // Empty reconciliation rows are not acceptance. The blocking exception rejects the batch.
      expect(out.reconciliation.allRowsMatch).toBe(true)
    })

    it(`reports a ${omitted ? "omitted" : "null"} voucher join without fabricating attachments`, () => {
      const s = clone(byName("unpaid").source)
      const debtor = s.entries.find((e) => e.customerNumber != null)!
      if (omitted) delete debtor.voucherNumber
      else debtor.voucherNumber = null
      const out = normalizeEconomic(s)
      expect(out.exceptions).toContainEqual(expect.objectContaining({ code: "voucher_number_missing", severity: "degraded", subject: "invoice:1001" }))
      expect(out.documents[0]).toMatchObject({ voucherNumber: null, attachedDocumentNumbers: [] })
      expect(out.documents[0]!.originalPdf.status).toBe("ok")
      expect(out.reconciliation.allRowsMatch).toBe(true)
    })
  }

  it("preserves an optional supplied delivery date and never fills it with the issue date", () => {
    const s = clone(byName("unpaid").source)
    // JSON fixtures and fetched provider data can contain this documented optional object.
    Object.assign(s.bookedInvoices[0]!, { delivery: { deliveryDate: "2026-09-02" } })
    expect(normalizeEconomic(s).documents[0]).toMatchObject({ supplyDate: "2026-09-02" })
    delete (s.bookedInvoices[0] as unknown as { delivery?: object }).delivery
    expect(normalizeEconomic(s).documents[0]).toMatchObject({ supplyDate: null })
    Object.assign(s.bookedInvoices[0]!, { delivery: {} })
    expect(normalizeEconomic(s).documents[0]).toMatchObject({ supplyDate: null })
  })

  for (const name of ["unpaid", "fully_paid", "foreign_currency", "credit_allocation"]) {
    it(`blocks wrong base gross in ${name} and omits affected allocation proofs`, () => {
      const s = clone(byName(name).source)
      s.bookedInvoices[0]!.grossAmountInBaseCurrency = 1
      const out = normalizeEconomic(s)
      expect(out.exceptions).toContainEqual(expect.objectContaining({ code: "debtor_line_base_amount_mismatch", severity: "blocking" }))
      expect(out.documents[0]).toMatchObject({ baseGross: 100, recomputedResidual: null, residualBasis: "source_remainder_only" })
      const affected = new Set(out.documents[0]!.ledgerEntryNumbers)
      expect(out.allocations.some((allocation) => affected.has(allocation.debitEntry) || affected.has(allocation.creditEntry))).toBe(false)
      expect(out.allocations).toHaveLength(byName(name).expect.allocations.length - (name === "unpaid" ? 0 : 1))
      expect(out.reconciliation.allRowsMatch).toBe(false)
    })
  }

  for (const type of [1, 2, 7, 8, 10, 6]) {
    it(`checks unknown customer on post-cutover type ${type} before filtering`, () => {
      const s = clone(byName("unpaid").source)
      s.customers = []
      s.bookedInvoices = []
      s.entries = s.entries.filter((e) => e.customerNumber != null)
      Object.assign(s.entries[0]!, { type, date: "2099-01-01", customerInvoiceNumber: null })
      const out = normalizeEconomic(s)
      expect(out.exceptions.filter((e) => e.code === "contact_unknown")).toEqual([
        expect.objectContaining({ severity: "blocking", subject: `entry:${s.entries[0]!.entryNumber}` }),
      ])
      expect(out.documents).toEqual([])
      expect(out.ledgerItems).toEqual([])
      expect(out.reconciliation.allRowsMatch).toBe(true)
    })
  }

  it("reports both document and debtor contact references without duplicate suppression", () => {
    const s = clone(byName("unpaid").source)
    s.customers = []
    const out = normalizeEconomic(s)
    expect(out.exceptions.filter((e) => e.code === "contact_unknown").map((e) => e.subject).sort()).toEqual([`entry:${s.entries.find((e) => e.customerNumber != null)!.entryNumber}`, "invoice:1001"])
  })

  it("rejects nested typos in realistic invoice objects and arrays", () => {
    const fields = snapshot.rest["/invoices/booked/:bookedInvoiceNumber"]!.fields
    expect(validateDocumentedPaths({ pdf: { dwonload: "https://synthetic.invalid" } }, fields)).toEqual(["pdf.dwonload"])
    expect(validateDocumentedPaths({ customer: { custmerNumber: 1 }, lines: [{ product: { prodcutNumber: 1 } }] }, fields)).toEqual(["customer.custmerNumber", "lines.product.prodcutNumber"])
    expect(validateDocumentedPaths({ lines: [{}, { unit: { nmae: "each" } }], invented: [] }, fields)).toEqual(["lines.unit.nmae", "invented"])
    expect(validateDocumentedPaths({ pdf: { download: "https://synthetic.invalid" }, customer: { customerNumber: 1 }, delivery: {}, lines: [{ description: "item", product: { productNumber: "P1" }, unit: { name: "each" } }], notes: null }, fields)).toEqual([])
  })

  it("maps accounting-year dependencies to the actual source input fields", () => {
    const row = matrix.rows.find((r) => r.contractField === "document.accountingYear")!
    expect(row.derivedFrom).toEqual(["input.debtorDate", "input.accountingYear", "input.accountingYearFromDate", "input.accountingYearToDate"])
    for (const [field, sourceField] of [["input.accountingYear", "year"], ["input.accountingYearFromDate", "fromDate"], ["input.accountingYearToDate", "toDate"]]) {
      expect(matrix.rows.find((r) => r.contractField === field)?.source).toMatchObject({ endpoint: "/accounting-years", field: sourceField, requiredRoles: ["SuperUser", "Bookkeeping"] })
    }
    const bad = clone(matrix)
    bad.rows.find((r) => r.contractField === "document.accountingYear")!.derivedFrom = ["input.nonexistent"]
    expect(validateMatrix(bad, snapshot).join("\n")).toContain("derivedFrom input.nonexistent")
  })

  it("does not label prospective requirements as emitted draft fields", () => {
    for (const field of ["document.vatTreatment", "document.correctsInvoice", "ledgerItem.paymentMethod", "allocation.matchedAt", "allocation.fxDifference", "control.unpaidTotals"]) {
      expect(matrix.rows.find((r) => r.contractField === field)?.inDraftContract).toBe(false)
    }
    const bad = clone(matrix)
    bad.rows.find((r) => r.contractField === "document.vatTreatment")!.inDraftContract = true
    expect(validateMatrix(bad, snapshot).join("\n")).toContain("document.vatTreatment: inDraftContract")
  })
})


describe("historical pair evidence over a connected cluster", () => {
  for (const endpoint of ["fromEntryAmount", "toEntryAmount"] as const) {
    for (const delta of [1, 0.001]) {
      for (const traversal of ["original", "repeated", "reversed"]) {
        it(`invalidates all three endpoints for ${endpoint} delta ${delta} in ${traversal} evidence`, () => {
          const s = clone(byName("fully_paid").source)
          const payment = s.entries.find((e) => e.type === 2)!
          payment.amount = payment.amountInBaseCurrency = -300
          s.entries.push({ ...payment, entryNumber: 99, amount: -325, amountInBaseCurrency: -325 })
          const first = s.matchedPairs[0]!
          first.toEntryAmount = first.toEntryAmountDKK = -300
          const second = { ...first, toEntry: 99, toEntryAmount: -325, toEntryAmountDKK: -325 }
          const invalid = traversal === "reversed" ? {
            fromEntry: second.toEntry, fromEntryDate: second.toEntryDate, fromEntryAmount: second.toEntryAmount, fromEntryAmountDKK: second.toEntryAmountDKK,
            toEntry: second.fromEntry, toEntryDate: second.fromEntryDate, toEntryAmount: second.fromEntryAmount, toEntryAmountDKK: second.fromEntryAmountDKK,
          } : clone(second)
          invalid[endpoint] += delta
          s.matchedPairs = traversal === "original" ? [first, invalid] : [first, second, invalid, clone(invalid)]
          const out = normalizeEconomic(s)
          expect(out.exceptions).toContainEqual(expect.objectContaining({ severity: "blocking", code: delta === 1 ? "pair_references_unknown_entry" : "sub_minor_precision" }))
          expect(out.clusters).toEqual([expect.objectContaining({ entries: [3, 4, 99], status: "inconsistent" })])
          expect(out.allocations).toEqual([])
          expect(out.reconciliation.rows).toHaveLength(3)
          expect(out.reconciliation.rows.every((row) => row.recomputedResidual === null && row.sourceResidual === 0)).toBe(true)
          expect(out.reconciliation.allRowsMatch).toBe(false)
        })
      }
    }
  }
})


describe("historical base and year validation controls", () => {
  for (const target of ["invoice", "debtor"] as const) {
    it(`withholds proof for sub-minor ${target} base gross even when rounded equal`, () => {
      const s = clone(byName("fully_paid").source)
      if (target === "invoice") s.bookedInvoices[0]!.grossAmountInBaseCurrency += 0.001
      else s.entries.find((e) => e.customerNumber != null && e.type === 1)!.amountInBaseCurrency += 0.001
      const out = normalizeEconomic(s)
      expect(out.exceptions).toContainEqual(expect.objectContaining({ code: "sub_minor_precision", severity: "blocking" }))
      expect(out.exceptions).toContainEqual(expect.objectContaining({ code: "debtor_line_base_amount_mismatch", severity: "blocking" }))
      expect(out.allocations).toEqual([])
      expect(out.documents[0]!.recomputedResidual).toBeNull()
      expect(out.reconciliation.allRowsMatch).toBe(false)
    })
  }

  it("blocks a corrupted negative credit base gross without changing its source sign", () => {
    const s = clone(byName("credit_allocation").source)
    const credit = s.bookedInvoices.find((invoice) => invoice.grossAmount < 0)!
    credit.grossAmountInBaseCurrency = -1
    const out = normalizeEconomic(s)
    const document = out.documents.find((item) => item.number === String(credit.bookedInvoiceNumber))!
    expect(out.exceptions).toContainEqual(expect.objectContaining({ code: "debtor_line_base_amount_mismatch", severity: "blocking", subject: document.sourceKey }))
    expect(document).toMatchObject({ kind: "credit_note", baseGross: -100, recomputedResidual: null })
    expect(out.allocations.some((allocation) => document.ledgerEntryNumbers.includes(allocation.creditEntry))).toBe(false)
    expect(out.reconciliation.allRowsMatch).toBe(false)
  })

  it("requires exact reported base amounts even when roundingAmount is nonzero", () => {
    const s = clone(byName("rounding").source)
    s.bookedInvoices[1]!.grossAmountInBaseCurrency -= 0.01
    const out = normalizeEconomic(s)
    expect(out.exceptions).toContainEqual(expect.objectContaining({ code: "debtor_line_base_amount_mismatch", severity: "blocking", subject: "invoice:1011" }))
    expect(out.documents[1]!.recomputedResidual).toBeNull()
  })

  it("uses debtor date and inclusive accounting-year bounds rather than invoice issue date", () => {
    const s = clone(byName("unpaid").source)
    s.bookedInvoices[0]!.date = "2025-12-31"
    s.entries.find((e) => e.customerNumber != null)!.date = "2026-01-01T00:00:00"
    expect(normalizeEconomic(s).documents[0]).toMatchObject({ issueDate: "2025-12-31", accountingYear: "2026", attachedDocumentNumbers: [910010] })
    s.entries.find((e) => e.customerNumber != null)!.date = "2025-12-31T00:00:00"
    expect(normalizeEconomic(s).documents[0]).toMatchObject({ accountingYear: "2025", attachedDocumentNumbers: [] })
  })

  it("validates accounting-year roles, source fields and dependency row completeness", () => {
    const bad = clone(matrix)
    const row = bad.rows.find((r) => r.contractField === "input.accountingYearFromDate")!
    row.source!.field = "startDate"
    row.source!.requiredRoles = ["Sales"]
    bad.rows = bad.rows.filter((r) => r.contractField !== "input.accountingYearToDate")
    const problems = validateMatrix(bad, snapshot).join("\n")
    expect(problems).toContain("has no documented field startDate")
    expect(problems).toContain("differ from the permissions page")
    expect(problems).toContain("input.accountingYearToDate: extraction input has no matrix row")
  })
})
