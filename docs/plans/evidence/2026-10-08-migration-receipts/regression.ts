// Pure analysis regression checks. Temporary copies only; no app, DB or provider calls.
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"

const dir = new URL("./", import.meta.url)
const economic = resolve(process.argv[2] ?? "../economic")
const original = readFileSync(new URL("staging-synthetic.json", dir), "utf8")
const fixture = JSON.parse(original)
const scratch = mkdtempSync(join(tmpdir(), "quits-migration-analysis-"))
const failures: string[] = []
let passed = 0
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex")

function run(bytes = original, check = false) {
  writeFileSync(join(scratch, "staging-synthetic.json"), bytes)
  const result = spawnSync(process.execPath, [join(scratch, "check.ts"), economic, ...(check ? ["--check"] : [])], { encoding: "utf8" })
  assert.ifError(result.error)
  assert.equal(result.signal, null)
  return result
}
function report(input: any) {
  const result = run(JSON.stringify(input, null, 2) + "\n")
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}
function test(name: string, check: () => void) {
  try { check(); passed++; console.log(`PASS: ${name}`) }
  catch (error) { failures.push(name); console.error(`FAIL: ${name}`, String(error)) }
}
function rejects(name: string, mutate: (input: any) => void) {
  test(name, () => {
    const input = structuredClone(fixture)
    mutate(input)
    const result = run(JSON.stringify(input, null, 2) + "\n")
    assert.notEqual(result.status, 0, "Invalid input produced a report")
    assert.equal(result.stdout, "", "Refusal must not print a partial report")
  })
}

try {
  writeFileSync(join(scratch, "check.ts"), readFileSync(new URL("check.ts", dir)))
  writeFileSync(join(scratch, "worked-report.json"), readFileSync(new URL("worked-report.json", dir)))
  // If the baseline fails, stop: rejection of every input is not a passing regression suite.
  const baseline = run()
  assert.equal(baseline.status, 0, baseline.stderr)
  const unchanged = run(original, true)
  assert.equal(unchanged.status, 0, unchanged.stderr)
  const output = JSON.parse(baseline.stdout)
  test("report binds exact local and upstream input bytes separately", () => {
    assert.equal(output.stagingFixtureSha256, hash(original))
    assert.equal(output.extractionFixtureSha256, hash(readFileSync(resolve(economic, "docs/migration/economic/fixtures/synthetic-scenarios.json"))))
  })
  for (const [name, mutate] of [
    ["profile", (x: any) => { x.profile += "; changed" }],
    ["receipt evidence", (x: any) => { x.receipts[0].evidence += ":changed" }],
    ["artifact media type", (x: any) => { x.invoices[1].artifact.mediaType = "application/octet-stream" }],
  ] as const) {
    test(`check rejects changed ${name} with an unchanged report`, () => {
      const input = structuredClone(fixture); mutate(input)
      assert.notEqual(run(JSON.stringify(input, null, 2) + "\n", true).status, 0)
    })
  }
  test("check rejects whitespace-only source changes", () => assert.notEqual(run(original + "\n", true).status, 0))
  test("two providers with identical account and object IDs stay distinct", () => {
    const a = report({ ...fixture, provider: "synthetic-provider-A" })
    const b = report({ ...fixture, provider: "synthetic-provider-B" })
    const keysA = a.retrySimulation.repeated.committedKeys
    const keysB = b.retrySimulation.repeated.committedKeys
    assert.equal(keysA.length, 16); assert.equal(keysB.length, 16)
    assert.equal(new Set([...keysA, ...keysB]).size, 32)
    assert.deepEqual(a.totals, b.totals)
  })
  rejects("missing provider refuses", x => { delete x.provider })
  rejects("same-provider duplicate contact refuses", x => { x.contacts.push({ ...x.contacts[0] }) })
  rejects("same-provider conflicting identity refuses", x => { x.invoices.push({ ...x.invoices[0], gross: "9,00" }) })
  rejects("pre-cutoff issued exclusion refuses", x => { x.excluded[0].date = "07.10.2026" })
  rejects("cutoff-day issued exclusion refuses", x => { x.excluded[0].date = "08.10.2026" })
  rejects("issued invoice labeled not_issued refuses", x => { x.excluded[1].issued = true; x.excluded[1].kind = "invoice" })
  rejects("draft mislabeled after_cutover refuses", x => { x.excluded[0].issued = false; x.excluded[0].kind = "draft" })
  rejects("unknown exclusion reason refuses", x => { x.excluded[0].reason = "unexplained" })
  rejects("missing exclusion state refuses", x => { delete x.excluded[1].issued })
  rejects("malformed excluded date refuses", x => { x.excluded[0].date = "31.02.2026" })
  rejects("included identity also excluded refuses", x => { x.excluded[0].id = x.invoices[0].id })
  test("changed payload refuses without writes and same-provider retry adds nothing", () => {
    assert.equal(output.retrySimulation.changedPayloadRejectedWithoutWrites, true)
    assert.equal(output.retrySimulation.repeated.added, 0)
    assert.equal(output.retrySimulation.repeated.committedKeys.length, 16)
  })
} finally { rmSync(scratch, { recursive: true, force: true }) }
console.log(`${passed} passed; ${failures.length} failed`)
assert.deepEqual(failures, [])
