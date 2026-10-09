import {
  CONTRACT_VERSION,
  type ClusterStatus,
  type CustomerControl,
  type ExceptionCode,
  type ImportAllocation,
  type ImportBundle,
  type ImportCluster,
  type ImportContact,
  type ImportDocument,
  type ImportException,
  type ImportLedgerItem,
  type ReconciliationRow,
  type Severity,
  type SourceBookedEntry,
  type SourceBundle,
} from "./types.ts"

// BookedEntries v6 `type` codes, from the OpenAPI enum EntryTypeNames.
const ENTRY_CUSTOMER_INVOICE = 1
const ENTRY_CUSTOMER_PAYMENT = 2
const ENTRY_OPENING = 7
const ENTRY_TRANSFERRED_OPENING = 8
const ENTRY_MANUAL_CUSTOMER_INVOICE = 10

const ZERO_EXPONENT = new Set(["JPY", "ISK", "KRW"])
const TWO_EXPONENT = new Set([
  "DKK", "EUR", "USD", "GBP", "SEK", "NOK", "CHF", "RON", "PLN", "CZK", "HUF", "CAD", "AUD",
])

class Collector {
  readonly list: ImportException[] = []
  add(code: ExceptionCode, severity: Severity, subject: string, detail: string) {
    if (this.list.some((e) => e.code === code && e.subject === subject && e.detail === detail)) return
    this.list.push({ code, severity, subject, detail })
  }
}

export function exponentFor(currency: string, issues: Collector | null = null, subject = `currency:${currency}`): number {
  if (ZERO_EXPONENT.has(currency)) return 0
  if (TWO_EXPONENT.has(currency)) return 2
  issues?.add("currency_exponent_unknown", "blocking", subject, `No supported minor-unit exponent for ${currency}; assumed 2 only to keep processing`)
  return 2
}

/** Convert a decimal from the API to integer minor units, reporting any sub-minor precision. */
export function toMinor(value: number, exponent: number, issues: Collector, subject: string): number {
  const scaled = value * 10 ** exponent
  const rounded = Math.round(scaled)
  if (Math.abs(scaled - rounded) > 1e-6) {
    issues.add("sub_minor_precision", "blocking", subject, `${value} has more precision than ${exponent} decimals; refused to round silently`)
  }
  return rounded
}

const day = (iso: string) => iso.slice(0, 10)

type Edge = { a: number; b: number }

function edgeKey(a: number, b: number) {
  return a < b ? `${a}:${b}` : `${b}:${a}`
}

/**
 * Turn an e-conomic extraction into the draft import contract, reporting every case it cannot prove.
 * Pure: no I/O, no clock.
 */
export function normalizeEconomic(src: SourceBundle): ImportBundle {
  const issues = new Collector()
  // Overlapping pages are not evidence that one payload is safe to prefer, even when identical.
  // Reject the batch before any Map can overwrite a row or a document can double its debt.
  const identities = [
    src.customers.map((c) => `customer:${c.customerNumber}`),
    src.bookedInvoices.map((i) => `invoice:${i.bookedInvoiceNumber}`),
    src.entries.map((e) => `entry:${e.entryNumber}`),
    src.attachedDocuments.map((d) => `attachedDocument:${d.number}`),
    src.accountingYears.map((y) => `accountingYear:${y.year}`),
  ]
  for (const keys of identities) {
    const seen = new Set<string>()
    for (const key of keys) {
      if (seen.has(key)) issues.add("duplicate_source_identity", "blocking", key, "Source identity occurs more than once; reject the whole batch and extract again without overlapping or conflicting pages")
      seen.add(key)
    }
  }
  if (issues.list.length > 0) {
    return {
      contractVersion: CONTRACT_VERSION, synthetic: true, provenance: src.extraction,
      contacts: [], documents: [], ledgerItems: [], allocations: [], clusters: [], excludedAfterCutover: [],
      exceptions: issues.list,
      reconciliation: { rows: [], customerControls: [], allRowsMatch: false },
    }
  }
  const base = src.extraction.baseCurrency
  const baseExp = exponentFor(base, issues)
  const cutover = src.extraction.cutoverDate

  // Contacts -----------------------------------------------------------------------------------
  const contacts: ImportContact[] = src.customers.map((c) => ({
    sourceId: `customer:${c.customerNumber}`,
    name: c.name,
    email: c.email ?? null,
    country: c.country ?? null,
    taxId: c.vatNumber ?? null,
    corporateId: c.corporateIdentificationNumber ?? null,
    endpointEan: c.ean ?? null,
    address: { line1: c.address ?? null, zip: c.zip ?? null, city: c.city ?? null },
  }))
  const knownCustomers = new Set(src.customers.map((c) => c.customerNumber))

  // Customer-ledger lines. Only entries carrying a customer number are open items; the revenue and
  // VAT lines of the same voucher share the invoice number but are not receivables.
  const ledger = new Map<number, SourceBookedEntry>()
  for (const e of src.entries) if (e.customerNumber != null) ledger.set(e.entryNumber, e)
  const entryCurrency = (e: SourceBookedEntry) => e.currencyCode ?? base
  const entryExp = (e: SourceBookedEntry) => exponentFor(entryCurrency(e), issues)
  const amountMinor = (e: SourceBookedEntry) => toMinor(e.amount, entryExp(e), issues, `entry:${e.entryNumber}`)
  const remainderMinor = (e: SourceBookedEntry): number | null => {
    if (e.remainder == null) {
      issues.add("remainder_missing", "blocking", `entry:${e.entryNumber}`, "Ledger entry has no remainder; open balance cannot be proven")
      return null
    }
    const r = toMinor(e.remainder, entryExp(e), issues, `entry:${e.entryNumber}`)
    const a = amountMinor(e)
    if (Math.abs(r) > Math.abs(a) || (r !== 0 && a !== 0 && Math.sign(r) !== Math.sign(a))) {
      issues.add("remainder_out_of_range", "blocking", `entry:${e.entryNumber}`, `remainder ${e.remainder} is not between 0 and amount ${e.amount}`)
    }
    return r
  }
  const applied = new Map<number, number>() // amount minus remainder, signed minor units
  for (const e of ledger.values()) {
    const r = remainderMinor(e)
    if (r != null) applied.set(e.entryNumber, amountMinor(e) - r)
  }

  // Matched pairs -> clusters ------------------------------------------------------------------
  const parent = new Map<number, number>()
  const find = (x: number): number => {
    let p = parent.get(x) ?? x
    if (p !== x) {
      p = find(p)
      parent.set(x, p)
    }
    return p
  }
  const union = (a: number, b: number) => {
    parent.set(find(a), find(b))
  }
  const edges: Edge[] = []
  const seen = new Set<string>()
  const invalidPairEntries = new Set<number>()
  for (const p of src.matchedPairs) {
    for (const [n, amt] of [[p.fromEntry, p.fromEntryAmount], [p.toEntry, p.toEntryAmount]] as const) {
      const e = ledger.get(n)
      if (!e) {
        issues.add("pair_references_unknown_entry", "blocking", `entry:${n}`, `Matched pair ${p.fromEntry}->${p.toEntry} points at an entry that is not a customer-ledger line in the extraction`)
        invalidPairEntries.add(n)
      } else {
        const pairIssues = new Collector()
        const exp = entryExp(e)
        const entryAmount = toMinor(e.amount, exp, pairIssues, `entry:${n}`)
        const pairAmount = toMinor(amt, exp, pairIssues, `entry:${n}`)
        // Rounded equality cannot validate amounts with unsupported precision. A local collector
        // keeps this decision independent of exception deduplication across repeated evidence.
        if (pairIssues.list.some((issue) => issue.severity === "blocking")) invalidPairEntries.add(n)
        for (const issue of pairIssues.list) issues.add(issue.code, issue.severity, issue.subject, issue.detail)
        if (entryAmount !== pairAmount) {
          issues.add("pair_references_unknown_entry", "blocking", `entry:${n}`, `Pair amount ${amt} differs from the entry amount ${e.amount}`)
          invalidPairEntries.add(n)
        }
      }
    }
    // Validate every occurrence before deduplication; one invalid pair taints its entire cluster.
    const key = edgeKey(p.fromEntry, p.toEntry)
    if (seen.has(key)) continue
    seen.add(key)
    edges.push({ a: p.fromEntry, b: p.toEntry })
    union(p.fromEntry, p.toEntry)
  }

  const members = new Map<number, number[]>()
  for (const edge of edges) {
    for (const n of [edge.a, edge.b]) {
      const root = find(n)
      const list = members.get(root) ?? []
      if (!list.includes(n)) list.push(n)
      members.set(root, list)
    }
  }

  const allocations: ImportAllocation[] = []
  const clusters: ImportCluster[] = []
  const entryCluster = new Map<number, string>()
  let clusterSeq = 0

  for (const nodes of [...members.values()].sort((x, y) => Math.min(...x) - Math.min(...y))) {
    nodes.sort((x, y) => x - y)
    const id = `cluster:${++clusterSeq}`
    for (const n of nodes) entryCluster.set(n, id)
    const clusterEdges = edges.filter((e) => nodes.includes(e.a))
    const known = nodes.filter((n) => ledger.has(n) && applied.has(n))
    const appliedRecord: Record<string, number> = {}
    for (const n of known) appliedRecord[String(n)] = applied.get(n) ?? 0
    let status: ClusterStatus = "resolved"
    const fail = (s: ClusterStatus) => {
      if (status === "inconsistent") return
      status = s
    }

    if (known.length !== nodes.length || nodes.some((n) => invalidPairEntries.has(n))) fail("inconsistent")

    const customers = new Set(known.map((n) => ledger.get(n)!.customerNumber))
    if (customers.size > 1) {
      issues.add("cluster_customer_mixed", "blocking", id, `Entries ${nodes.join(", ")} belong to customers ${[...customers].join(", ")}; cross-customer allocations require a supported transfer rule that this extraction does not provide`)
      fail("inconsistent")
    }

    const currencies = new Set(known.map((n) => entryCurrency(ledger.get(n)!)))
    if (status === "resolved" && currencies.size > 1) {
      issues.add("cluster_currency_mixed", "blocking", id, `Entries ${nodes.join(", ")} mix ${[...currencies].join(" and ")}; amounts cannot be compared without a verified conversion rule`)
      fail("ambiguous")
    }

    if (status === "resolved") {
      const sum = known.reduce((s, n) => s + (applied.get(n) ?? 0), 0)
      if (sum !== 0) {
        issues.add("cluster_not_conserved", "blocking", id, `Applied amounts across entries ${nodes.join(", ")} sum to ${sum} minor units, not zero`)
        fail("inconsistent")
      }
    }

    if (status === "resolved" && clusterEdges.length > nodes.length - 1) {
      issues.add("allocation_ambiguous", "degraded", id, `${clusterEdges.length} pairs over ${nodes.length} entries form a cycle; per-entry applied totals are exact but pair amounts are not unique`)
      fail("ambiguous")
    }

    if (status === "resolved") {
      const need = new Map(known.map((n) => [n, applied.get(n) ?? 0]))
      const remaining = clusterEdges.map((e) => ({ ...e }))
      const solved: { a: number; b: number; f: number }[] = []
      let progress = true
      while (remaining.length > 0 && progress) {
        progress = false
        for (const node of nodes) {
          const incident = remaining.filter((e) => e.a === node || e.b === node)
          if (incident.length !== 1) continue
          const e = incident[0]!
          const f = e.a === node ? need.get(node)! : -need.get(node)!
          solved.push({ a: e.a, b: e.b, f })
          const other = e.a === node ? e.b : e.a
          need.set(other, need.get(other)! - (other === e.a ? f : -f))
          need.set(node, 0)
          remaining.splice(remaining.indexOf(e), 1)
          progress = true
        }
      }
      for (const s of solved) {
        if (s.f === 0) continue
        const debit = s.f > 0 ? s.a : s.b
        const credit = s.f > 0 ? s.b : s.a
        const d = ledger.get(debit)!
        const c = ledger.get(credit)!
        const amt = Math.abs(s.f)
        if (amountMinor(d) < 0 || amountMinor(c) > 0 || amt > Math.abs(amountMinor(d)) || amt > Math.abs(amountMinor(c))) {
          issues.add("allocation_sign_inconsistent", "blocking", id, `Pair ${s.a}->${s.b} solves to ${amt} applied from entry ${credit} to entry ${debit}, which contradicts the entry signs or sizes`)
          fail("inconsistent")
          continue
        }
        allocations.push({ debitEntry: debit, creditEntry: credit, amount: amt, currency: entryCurrency(d), exponent: entryExp(d), clusterId: id })
      }
      if (status === "resolved") {
        const allClosed = known.every((n) => remainderOf(ledger.get(n)!) === 0)
        if (allClosed && currencies.size === 1 && !currencies.has(base)) {
          const delta = known.reduce((s, n) => s + toMinor(ledger.get(n)!.amountInBaseCurrency, baseExp, issues, `entry:${n}`), 0)
          if (delta !== 0) {
            issues.add("fx_difference_unattributed", "info", id, `Fully matched ${[...currencies][0]} entries differ by ${delta} ${base} minor units in base currency; not shown on any matched entry, so the exchange difference is not importable from this extraction`)
          }
        }
      }
    }
    clusters.push({ id, entries: nodes, status, applied: appliedRecord })
  }

  function remainderOf(e: SourceBookedEntry): number {
    return e.remainder == null ? Number.NaN : toMinor(e.remainder, entryExp(e), issues, `entry:${e.entryNumber}`)
  }

  // Applied amounts that no pair explains are visible history we cannot reproduce.
  for (const e of ledger.values()) {
    const ap = applied.get(e.entryNumber)
    if (ap && ap !== 0 && !entryCluster.has(e.entryNumber)) {
      issues.add("applied_without_match_pair", "degraded", `entry:${e.entryNumber}`, `Entry ${e.entryNumber} has ${e.amount - (e.remainder ?? 0)} applied but appears in no matched pair; allocation history is unsupported for it`)
      const id = `cluster:${++clusterSeq}`
      entryCluster.set(e.entryNumber, id)
      clusters.push({ id, entries: [e.entryNumber], status: "ambiguous", applied: { [String(e.entryNumber)]: ap } })
    }
  }

  // Documents ----------------------------------------------------------------------------------
  const documents: ImportDocument[] = []
  const excludedAfterCutover: string[] = []
  const debtorEntryOfDocument = new Set<number>()
  const invalidDocumentJoins = new Set<string>()
  const invoiceLines = new Map<number, SourceBookedEntry[]>()
  for (const e of src.entries) {
    if (e.type === ENTRY_CUSTOMER_INVOICE && e.customerInvoiceNumber != null) {
      const list = invoiceLines.get(e.customerInvoiceNumber) ?? []
      list.push(e)
      invoiceLines.set(e.customerInvoiceNumber, list)
    }
  }
  const docNumbers = new Set(src.bookedInvoices.map((i) => i.bookedInvoiceNumber))

  for (const inv of src.bookedInvoices) {
    const key = `invoice:${inv.bookedInvoiceNumber}`
    const exp = exponentFor(inv.currency, issues, key)
    const net = toMinor(inv.netAmount, exp, issues, key)
    const tax = toMinor(inv.vatAmount, exp, issues, key)
    const gross = toMinor(inv.grossAmount, exp, issues, key)
    const rounding = toMinor(inv.roundingAmount ?? 0, baseExp, issues, key)
    const baseGross = toMinor(inv.grossAmountInBaseCurrency, baseExp, issues, key)
    if (rounding !== 0) {
      issues.add("rounding_semantics_unverified", "info", key, `roundingAmount ${inv.roundingAmount} (${base}); whether gross includes it is not documented, so the totals check accepts gross = net + VAT or net + VAT + rounding`)
    }
    const diff = gross - (net + tax)
    const roundingInDoc = inv.currency === base ? rounding : 0
    if (diff !== 0 && diff !== roundingInDoc) {
      issues.add("invoice_total_mismatch", "blocking", key, `gross ${inv.grossAmount} differs from net ${inv.netAmount} + VAT ${inv.vatAmount} by ${diff} minor units (rounding ${rounding})`)
    }

    const debtor = [...ledger.values()].filter((e) => e.type === ENTRY_CUSTOMER_INVOICE && e.customerInvoiceNumber === inv.bookedInvoiceNumber)
    const currenciesMatch = debtor.every((e) => entryCurrency(e) === inv.currency)
    if (!currenciesMatch) {
      issues.add("debtor_line_currency_mismatch", "blocking", key, `Invoice currency ${inv.currency} differs from debtor-line currencies ${[...new Set(debtor.map(entryCurrency))].join(", ")}; amounts and residuals cannot be compared`)
      invalidDocumentJoins.add(key)
    }
    const afterCutover = day(inv.date) > cutover
    if (debtor.length === 0) {
      issues.add("invoice_without_ledger_entry", "blocking", key, "No customer-ledger entry carries this invoice number; residual cannot be checked against BookedEntries")
      invalidDocumentJoins.add(key)
    }
    if (debtor.length > 1) {
      issues.add("multiple_debtor_lines", "degraded", key, `${debtor.length} customer-ledger lines carry invoice ${inv.bookedInvoiceNumber}; amounts and remainders are summed`)
    }
    for (const e of debtor) debtorEntryOfDocument.add(e.entryNumber)
    if (debtor.length > 0) {
      if (currenciesMatch) {
        const sum = debtor.reduce((s, e) => s + amountMinor(e), 0)
        if (sum !== gross) {
          issues.add("debtor_line_amount_mismatch", "blocking", key, `Ledger lines sum to ${sum} but the booked invoice gross is ${gross} (${inv.currency} minor units)`)
          invalidDocumentJoins.add(key)
        }
      }
      if (debtor.some((e) => e.customerNumber !== inv.customer.customerNumber)) {
        issues.add("debtor_line_amount_mismatch", "blocking", key, "Ledger line customer differs from the invoice customer")
        invalidDocumentJoins.add(key)
      }
    }
    const lines = invoiceLines.get(inv.bookedInvoiceNumber) ?? []
    if (lines.length > 0) {
      const sumBase = lines.reduce((s, e) => s + toMinor(e.amountInBaseCurrency, baseExp, issues, `entry:${e.entryNumber}`), 0)
      if (Math.abs(sumBase) > 1) {
        issues.add("invoice_ledger_lines_unbalanced", "blocking", key, `Revenue, VAT and debtor lines of the voucher sum to ${sumBase} ${base} minor units, not zero`)
      }
    }

    if (!knownCustomers.has(inv.customer.customerNumber)) {
      issues.add("contact_unknown", "blocking", key, `Customer ${inv.customer.customerNumber} is not in the customer extraction`)
    }

    const sourceRest = toMinor(inv.remainder, exp, issues, key)
    const entryRemainders = debtor.map((e) => remainderMinor(e))
    const entrySum = currenciesMatch && entryRemainders.every((r) => r != null) ? entryRemainders.reduce<number>((s, r) => s + (r ?? 0), 0) : null
    if (currenciesMatch && entrySum != null && entrySum !== sourceRest) {
      issues.add("remainder_disagreement", "blocking", key, `Booked invoice remainder ${inv.remainder} (REST) differs from the ledger-line remainder ${entrySum / 10 ** exp} (BookedEntries)`)
    }

    if (afterCutover) {
      excludedAfterCutover.push(key)
      issues.add("document_after_cutover", "info", key, `Dated ${day(inv.date)}, after the cutover ${cutover}; not imported as history`)
      continue
    }

    // Artifacts.
    const first = debtor[0]
    const voucher = first?.voucherNumber ?? null
    const year = first ? (src.accountingYears.find((y) => day(first.date) >= y.fromDate && day(first.date) <= y.toDate)?.year ?? null) : null
    if (first && year == null) {
      issues.add("voucher_year_unresolved", "degraded", key, `Entry date ${day(first.date)} is outside every extracted accounting year; the Documents API cannot be joined`)
    }
    const attached = year != null && voucher != null
      ? src.attachedDocuments.filter((d) => d.voucherNumber === voucher && d.accountingYear === year).map((d) => d.number)
      : []
    const pdf: ImportDocument["originalPdf"] = src.invoicePdfs[String(inv.bookedInvoiceNumber)] ?? { status: "not_fetched" }
    if (pdf.status === "missing" || pdf.status === "not_fetched") {
      issues.add("original_pdf_missing", "degraded", key, pdf.status === "missing" ? "The booked-invoice PDF endpoint returned no document" : "The original PDF was not fetched in this extraction")
    } else if (pdf.status === "error") {
      issues.add("original_pdf_fetch_failed", "degraded", key, `The booked-invoice PDF could not be fetched (HTTP ${pdf.httpStatus ?? "unknown"}); retry before declaring the document set complete`)
    }

    documents.push({
      sourceKey: key,
      kind: gross < 0 ? "credit_note" : "invoice",
      number: String(inv.bookedInvoiceNumber),
      contactSourceId: `customer:${inv.customer.customerNumber}`,
      issueDate: day(inv.date),
      dueDate: inv.dueDate ? day(inv.dueDate) : null,
      currency: inv.currency,
      exponent: exp,
      net,
      tax,
      gross,
      rounding,
      baseGross,
      exchangeRate: inv.exchangeRate,
      ledgerEntryNumbers: debtor.map((e) => e.entryNumber),
      voucherNumber: voucher,
      accountingYear: year,
      originalPdf: pdf,
      attachedDocumentNumbers: attached,
      sourceResidual: sourceRest,
      recomputedResidual: null,
      residualBasis: "source_remainder_only",
    })
  }

  // Debtor lines whose invoice was not extracted.
  for (const e of ledger.values()) {
    if (e.type === ENTRY_CUSTOMER_INVOICE && e.customerInvoiceNumber != null && !docNumbers.has(e.customerInvoiceNumber)) {
      issues.add("ledger_entry_without_invoice", "blocking", `entry:${e.entryNumber}`, `Ledger line references invoice ${e.customerInvoiceNumber}, which GET /invoices/booked did not return`)
    }
  }

  // Non-document ledger items --------------------------------------------------------------------
  const ledgerItems: ImportLedgerItem[] = []
  for (const e of [...ledger.values()].sort((x, y) => x.entryNumber - y.entryNumber)) {
    if (debtorEntryOfDocument.has(e.entryNumber)) continue
    if (e.type === ENTRY_CUSTOMER_INVOICE) continue
    const subject = `entry:${e.entryNumber}`
    let kind: ImportLedgerItem["kind"] | null = null
    if (e.type === ENTRY_CUSTOMER_PAYMENT) kind = e.amount < 0 ? "payment" : "payment_reversal"
    else if (e.type === ENTRY_OPENING || e.type === ENTRY_TRANSFERRED_OPENING) kind = "opening_balance"
    else if (e.type === ENTRY_MANUAL_CUSTOMER_INVOICE) {
      kind = "manual_invoice"
      issues.add("manual_invoice_has_no_document", "degraded", subject, "A manual customer invoice posted through a journal has no booked-invoice resource and no PDF; only its open balance is importable")
    } else {
      issues.add("entry_type_unsupported", "degraded", subject, `Customer-ledger entry of type ${e.type} is not mapped; its balance effect is only visible in the control totals`)
    }
    if (day(e.date) > cutover) continue
    if (kind == null) continue
    if (!knownCustomers.has(e.customerNumber!)) issues.add("contact_unknown", "blocking", subject, `Customer ${e.customerNumber} is not in the customer extraction`)
    const exp = entryExp(e)
    const rem = remainderOf(e)
    ledgerItems.push({
      sourceKey: subject,
      entryNumber: e.entryNumber,
      kind,
      contactSourceId: `customer:${e.customerNumber}`,
      date: day(e.date),
      currency: entryCurrency(e),
      exponent: exp,
      amount: amountMinor(e),
      baseAmount: toMinor(e.amountInBaseCurrency, baseExp, issues, subject),
      sourceResidual: Number.isNaN(rem) ? 0 : rem,
    })
  }

  // Solve over the complete extraction, but emit allocations only for complete, resolved clusters
  // whose endpoints are represented in the import scope. Dropping just an out-of-scope edge would
  // misstate the remaining entries' applied totals. Clusters remain full-snapshot diagnostics.
  const represented = new Set([...documents.flatMap((d) => d.ledgerEntryNumbers), ...ledgerItems.map((i) => i.entryNumber)])
  const invalidEntries = new Set(documents.filter((d) => invalidDocumentJoins.has(d.sourceKey)).flatMap((d) => d.ledgerEntryNumbers))
  const eligibleClusters = new Set(clusters.filter((c) => c.status === "resolved" && c.entries.every((n) => represented.has(n) && !invalidEntries.has(n) && day(ledger.get(n)!.date) <= cutover)).map((c) => c.id))
  const scopedAllocations = allocations.filter((a) => eligibleClusters.has(a.clusterId))
  const flowOnEntry = new Map<number, number>()
  for (const a of scopedAllocations) {
    flowOnEntry.set(a.debitEntry, (flowOnEntry.get(a.debitEntry) ?? 0) + a.amount)
    flowOnEntry.set(a.creditEntry, (flowOnEntry.get(a.creditEntry) ?? 0) + a.amount)
  }
  const canRecompute = (n: number): boolean => {
    const cid = entryCluster.get(n)
    return !invalidEntries.has(n) && day(ledger.get(n)!.date) <= cutover && (cid == null || eligibleClusters.has(cid))
  }
  const snapshotOnly = (subject: string) => issues.add("snapshot_residual_only", "degraded", subject, `Residual rests on the source snapshot alone because the match cluster is unresolved or has an endpoint outside the valid import scope through ${cutover}; no match date is available to reconstruct an earlier residual`)
  for (const d of documents) {
    if (invalidDocumentJoins.has(d.sourceKey)) continue
    if (d.ledgerEntryNumbers.length > 0 && d.ledgerEntryNumbers.every(canRecompute)) {
      d.recomputedResidual = d.ledgerEntryNumbers.reduce((s, n) => {
        const amount = amountMinor(ledger.get(n)!)
        return s + amount - Math.sign(amount) * (flowOnEntry.get(n) ?? 0)
      }, 0)
      d.residualBasis = "recomputed_from_allocations"
    } else {
      snapshotOnly(d.sourceKey)
    }
  }

  // Reconciliation -------------------------------------------------------------------------------
  const rows: ReconciliationRow[] = []
  for (const d of documents) {
    rows.push({
      contactSourceId: d.contactSourceId,
      currency: d.currency,
      documentKey: d.sourceKey,
      kind: d.kind === "credit_note" && d.sourceResidual !== 0 ? "open_credit" : "document",
      sourceResidual: d.sourceResidual,
      recomputedResidual: d.recomputedResidual,
      match: d.recomputedResidual == null ? null : d.recomputedResidual === d.sourceResidual,
    })
  }
  for (const item of ledgerItems) {
    const recomputed = canRecompute(item.entryNumber) ? item.amount - Math.sign(item.amount) * (flowOnEntry.get(item.entryNumber) ?? 0) : null
    if (recomputed == null && clusters.find((c) => c.id === entryCluster.get(item.entryNumber))?.status === "resolved") snapshotOnly(item.sourceKey)
    if (item.sourceResidual === 0 && recomputed === 0) continue
    rows.push({
      contactSourceId: item.contactSourceId,
      currency: item.currency,
      documentKey: null,
      kind: item.kind === "payment" && item.sourceResidual < 0 ? "unapplied_cash" : "ledger_item",
      sourceResidual: item.sourceResidual,
      recomputedResidual: recomputed,
      match: recomputed == null ? null : recomputed === item.sourceResidual,
    })
  }

  const customerControls: CustomerControl[] = []
  for (const c of src.customers) {
    const own = [...ledger.values()].filter((e) => e.customerNumber === c.customerNumber)
    let total = 0
    let tolerance = 0
    for (const e of own) {
      const a = amountMinor(e)
      const r = remainderOf(e)
      if (Number.isNaN(r) || a === 0) continue
      const baseAmount = toMinor(e.amountInBaseCurrency, baseExp, issues, `entry:${e.entryNumber}`)
      if (r === a) total += baseAmount
      else if (r !== 0) {
        total += Math.round((baseAmount * r) / a)
        tolerance += 1
      }
    }
    const sourceBalance = c.balance == null ? null : toMinor(c.balance, baseExp, issues, `customer:${c.customerNumber}`)
    const diff = sourceBalance == null ? null : sourceBalance - total
    if (diff != null && Math.abs(diff) > tolerance) {
      issues.add("customer_balance_disagreement", "degraded", `customer:${c.customerNumber}`, `customer.balance is ${diff} ${base} minor units away from the sum of ledger remainders (tolerance ${tolerance}); report it, do not average it away`)
    }
    customerControls.push({ contactSourceId: `customer:${c.customerNumber}`, baseCurrency: base, ledgerResidualBase: total, sourceBalanceBase: sourceBalance, differenceBase: diff, toleranceBase: tolerance })
  }

  return {
    contractVersion: CONTRACT_VERSION,
    synthetic: true,
    provenance: src.extraction,
    contacts,
    documents,
    ledgerItems,
    allocations: scopedAllocations,
    clusters,
    excludedAfterCutover,
    exceptions: issues.list,
    reconciliation: { rows, customerControls, allRowsMatch: rows.every((r) => r.match === true) },
  }
}
