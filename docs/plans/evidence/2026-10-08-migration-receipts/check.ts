// Analysis only. Reads fixtures and a pinned public OSS checkout; writes only stdout.
// No database, network, provider, scheduler or application command is imported.
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { pathToFileURL } from "node:url"

const dir = new URL("./", import.meta.url)
const fixture = JSON.parse(readFileSync(new URL("staging-synthetic.json", dir), "utf8"))
const pinned = "6d9c9fcbd678bf4800ad5c21bea791779acdbab2"
const economic = resolve(process.argv[2] ?? "../economic")
function git(...args: string[]) {
  const result = spawnSync("git", ["-C", economic, ...args], { encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}
assert.equal(git("rev-parse", "HEAD"), pinned, "Use the accepted #29 checkout")
assert.equal(git("status", "--porcelain", "--", "scripts/economic-discovery", "docs/migration/economic"), "")
const { normalizeEconomic } = await import(pathToFileURL(resolve(economic, "scripts/economic-discovery/normalize.ts")).href)
const sourceBytes = readFileSync(resolve(economic, "docs/migration/economic/fixtures/synthetic-scenarios.json"))
const upstream = JSON.parse(sourceBytes.toString())
assert.equal(upstream.synthetic, true)
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex")

// Exact Danish input profile for this example only. No automatic locale detection.
function minor(value: string): number {
  assert.match(value, /^-?(?:0|[1-9]\d*|[1-9]\d{0,2}(?:\.\d{3})+),\d{2}$/)
  const result = Number(value.replaceAll(".", "").replace(",", ""))
  assert(Number.isSafeInteger(result))
  return result
}
function day(value: string): string {
  assert.match(value, /^\d{2}\.\d{2}\.\d{4}$/)
  const [d, m, y] = value.split(".")
  const iso = `${y}-${m}-${d}`
  assert.equal(new Date(`${iso}T00:00:00Z`).toISOString().slice(0, 10), iso)
  return iso
}
assert.equal(minor("1.250,00"), 125000)
assert.equal(day("30.09.2026"), "2026-09-30")
for (const bad of ["1,250.00", "1.25,00", "1,001", "1.000", "1e3"]) assert.throws(() => minor(bad))
for (const bad of ["31.02.2026", "2026-09-30", "01/02/26"]) assert.throws(() => day(bad))

// Reuse the accepted normalizer and every existing scenario. Do not fabricate exports.
const extraction = upstream.scenarios.map((s: any) => {
  const out = normalizeEconomic(s.source)
  assert.equal(out.reconciliation.allRowsMatch, s.expect.allRowsMatch, s.name)
  assert.deepEqual(out.documents.map((d: any) => d.sourceKey).sort(), Object.keys(s.expect.documents).sort())
  const exceptions = out.exceptions.map((e: any) => `${e.code}@${e.subject}`).sort()
  assert.deepEqual(exceptions, s.expect.exceptions.map((e: any) => `${e.code}@${e.subject}`).sort(), s.name)
  for (const d of out.documents) {
    const expected = s.expect.documents[d.sourceKey]
    assert.equal(d.sourceResidual, expected.residual)
    assert.equal(d.residualBasis, expected.residualBasis)
    assert.equal(d.originalPdf.status, expected.pdf)
  }
  const pairKey = (a: any) => `${a.debitEntry}:${a.creditEntry}:${a.amount}`
  assert.deepEqual(out.allocations.map(pairKey).sort(), s.expect.allocations.map(pairKey).sort())
  return { scenario: s.name, documents: out.documents.length, ledgerItems: out.ledgerItems.length,
    allocations: out.allocations.length, allRowsMatch: out.reconciliation.allRowsMatch,
    exceptions, excludedAfterCutover: out.excludedAfterCutover }
})
const duplicateSource = structuredClone(upstream.scenarios[0].source)
duplicateSource.bookedInvoices.push(structuredClone(duplicateSource.bookedInvoices[0]))
const rejectedSource = normalizeEconomic(duplicateSource)
assert.equal(rejectedSource.documents.length, 0)
assert(rejectedSource.exceptions.some((e: any) => e.code === "duplicate_source_identity"))

assert.equal(fixture.synthetic, true)
const rows: any[] = []
for (const kind of ["contacts", "invoices", "credits", "receipts", "allocations"]) {
  for (const record of fixture[kind]) {
    rows.push({ key: `${fixture.organization}/${fixture.sourceAccount}/${kind}/${record.id}`, kind, record })
  }
}
function validateIdentities(input: any[]) {
  const identities = new Set<string>()
  for (const row of input) {
    assert(!identities.has(row.key), `duplicate_source_identity:${row.key}`)
    identities.add(row.key)
  }
}
validateIdentities(rows)
assert.throws(() => validateIdentities([...rows, rows[0]]))
assert.throws(() => validateIdentities([...rows, { ...rows[0], record: { id: "changed" } }]))

const totals: Record<string, any> = {}
const documentRows = fixture.invoices.map((i: any) => {
  assert(i.issued)
  assert(day(i.date) <= fixture.asOf)
  assert(fixture.contacts.some((c: any) => c.id === i.customer))
  const credit = fixture.credits.filter((c: any) => c.invoice === i.id).reduce((n: number, c: any) => {
    assert.equal(c.customer, i.customer); assert.equal(c.currency, i.currency)
    assert(day(c.date) <= fixture.asOf)
    return n + minor(c.amount)
  }, 0)
  const paid = fixture.allocations.filter((a: any) => a.invoice === i.id).reduce((n: number, a: any) => {
    const r = fixture.receipts.find((r: any) => r.id === a.receipt)
    assert(r); assert.equal(r.customer, i.customer); assert.equal(r.currency, i.currency)
    assert(day(r.date) <= fixture.asOf)
    assert(minor(a.amount) > 0)
    return n + minor(a.amount)
  }, 0)
  const gross = minor(i.gross), outstanding = gross - credit - paid
  assert(outstanding >= 0)
  assert.equal(outstanding, minor(i.sourceResidual))
  const t = totals[i.currency] ??= { invoices: 0, invoiced: 0, credited: 0, paid: 0, outstanding: 0, receiptGross: 0, unapplied: 0 }
  t.invoices++; t.invoiced += gross; t.credited += credit; t.paid += paid; t.outstanding += outstanding
  return { sourceId: i.id, originalNumber: i.number, date: day(i.date), currency: i.currency,
    gross, credited: credit, paid, outstanding, sourceResidual: minor(i.sourceResidual),
    artifact: i.artifact.state, syntheticArtifactHash: i.artifact.syntheticText ? hash(i.artifact.syntheticText) : null }
})
for (const r of fixture.receipts) {
  const allocated = fixture.allocations.filter((a: any) => a.receipt === r.id).reduce((n: number, a: any) => n + minor(a.amount), 0)
  const gross = minor(r.gross)
  assert.equal(minor(r.fee), 0, "Fee policy is outside this worked dataset")
  assert(gross >= allocated)
  totals[r.currency].receiptGross += gross
  totals[r.currency].unapplied += gross - allocated
}
assert.deepEqual(totals.DKK, { invoices: 3, invoiced: 275000, credited: 25000, paid: 90000, outstanding: 160000, receiptGross: 100000, unapplied: 10000 })
assert.deepEqual(totals.EUR, { invoices: 2, invoiced: 30000, credited: 0, paid: 22000, outstanding: 8000, receiptGross: 22000, unapplied: 0 })

// A deliberately in-memory retry example. It does not establish database durability,
// atomicity, concurrency safety or crash recovery in the application.
const memory = new Map<string, string>()
function simulateBatch(input: any[], failAfter = Infinity) {
  validateIdentities(input)
  // Refuse changed payloads before considering any new row in the batch.
  for (const r of input) {
    if (memory.has(r.key)) assert.equal(memory.get(r.key), hash(JSON.stringify(r.record)), "source_revision_conflict")
  }
  let added = 0
  for (const r of input) {
    if (memory.has(r.key)) continue
    if (added === failAfter) return { outcome: "simulated_failure", added, committedKeys: [...memory.keys()] }
    memory.set(r.key, hash(JSON.stringify(r.record))); added++
  }
  return { outcome: "complete", added, committedKeys: [...memory.keys()] }
}
const failure = simulateBatch(rows, 4), resumed = simulateBatch(rows), repeated = simulateBatch(rows)
assert.equal(failure.added, 4); assert.equal(resumed.added, 12); assert.equal(repeated.added, 0)
assert.equal(memory.size, 16)
const beforeConflict = [...memory.entries()]
assert.throws(() => simulateBatch([{ ...rows[2], record: { ...rows[2].record, gross: "9,00" } }]))
assert.deepEqual([...memory.entries()], beforeConflict)
const collisions = documentRows.filter((i: any) => fixture.targetNumbers.includes(i.originalNumber)).map((i: any) => i.sourceId)
assert.deepEqual(collisions, ["I1"])
const report = {
  status: "synthetic analysis only; operational import and cutover are blocked",
  sourceCheckout: pinned, extractionFixtureSha256: hash(sourceBytes),
  units: "integer minor units; DKK and EUR exponent 2; no cross-currency netting",
  counts: { contacts: 2, invoices: 5, credits: 1, receipts: 4, allocations: 4, staged: rows.length,
    excluded: fixture.excluded.length, availableSyntheticArtifacts: 3, missingArtifacts: 1, failedArtifacts: 1 },
  totals, documents: documentRows, exclusions: fixture.excluded,
  numberingCollisionsBlockingCommit: collisions,
  retrySimulation: { failure, resumed, repeated, changedPayloadRejectedWithoutWrites: true,
    duplicateIdsRejectWholeBatch: true },
  sideEffects: "No application or provider operations exist in this analysis script. Runtime isolation is untested.",
  extractionScenarios: extraction,
  unmet: ["source page/count controls", "unpaid-total semantics and comparison", "real export columns", "real grant/plan tests", "approved provenance persistence", "database resume/concurrency tests", "consented pilot", "qualified cutover/retention review"],
}
const json = JSON.stringify(report, null, 2) + "\n"
if (process.argv.includes("--check")) {
  assert.equal(json, readFileSync(new URL("worked-report.json", dir), "utf8"))
  console.log("PASS: 15 accepted extraction scenarios, Danish input rejection checks, per-currency reconciliation, duplicate identities, collision, failure/resume/replay and report equality")
} else process.stdout.write(json)
