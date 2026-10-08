import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { CONTRACT_FIELDS, validateMatrix, type Matrix, type Snapshot } from "../economic-discovery/matrix.ts"
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

  it("blocks when a pair amount differs from the entry it names", () => {
    const s = clone(byName("fully_paid").source)
    s.matchedPairs[0]!.fromEntryAmount += 1
    expect(normalizeEconomic(s).exceptions.some((e) => e.code === "pair_references_unknown_entry")).toBe(true)
  })

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
    expect(matrix.rows).toHaveLength(CONTRACT_FIELDS.length)
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
    expect([...rest].sort()).toEqual(["Sales", "SuperUser"])
    expect([...entries].sort()).toEqual(["Bookkeeping", "SuperUser"])
  })
})

describe("fixtures use only documented field names", () => {
  const top = (fields: string[]) => new Set(fields.map((f) => f.split(".")[0]!))
  it("matches the documentation snapshot for every payload", () => {
    const customers = top(snapshot.rest["/customers"]!.fields)
    const invoices = top(snapshot.rest["/invoices/booked/:bookedInvoiceNumber"]!.fields)
    const entry = new Set(snapshot.openapi.BookedEntries.schemas.BookedEntry)
    const pair = new Set(snapshot.openapi.BookedEntries.schemas.MatchedBookedEntriesPair)
    const attached = new Set(snapshot.openapi.Documents.schemas.AttachedDocument)
    const years = top(snapshot.rest["/accounting-years"]!.fields)
    const unknown: string[] = []
    const check = (label: string, obj: object, allowed: Set<string>) => {
      for (const k of Object.keys(obj)) if (!allowed.has(k)) unknown.push(`${label}.${k}`)
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
