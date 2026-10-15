import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { runCopyCheck } from "../i18n-copy-check.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const rulesPath = resolve(here, "../i18n/copy-rules.json")

function fixture(t, en, da) {
  const root = mkdtempSync(join(tmpdir(), "copy-check-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const [lang, body] of [["en", en], ["da", da]]) {
    mkdirSync(join(root, lang))
    writeFileSync(join(root, lang, "x.ts"), `export const m = {\n${body}\n} as const\n`)
  }
  return root
}

function findings(catalogRoot) {
  return runCopyCheck({ catalogRoot, rulesPath, root: catalogRoot }).findings.map((f) => `${f.ruleId}:${f.key}`)
}

test("the real catalogs pass", () => {
  assert.deepEqual(findings(resolve(here, "../../apps/oss/src/lib/i18n/catalog")), [])
})

test("flags Danish values left identical to English, with allowlist and no-letter skips", (t) => {
  const root = fixture(
    t,
    `  "a.title": "Invoice settings",\n  "a.total": "Total",\n  "a.n": "{count}",\n  "a.url": "https://example.com/x"`,
    `  "a.title": "Invoice settings",\n  "a.total": "Total",\n  "a.n": "{count}",\n  "a.url": "https://example.com/x"`
  )
  assert.deepEqual(findings(root), ["untranslated:a.title"])
})

test("fails on open source in either language, including multi-line entries", (t) => {
  const root = fixture(
    t,
    `  "a.one": "Quits is open-source software",\n  "a.two":\n    "Fully Open Source"`,
    `  "a.one": "Quits er software med åben kildekode",\n  "a.two":\n    "Helt open source"`
  )
  assert.deepEqual(findings(root).sort(), ["open-source:a.one", "open-source:a.one", "open-source:a.two", "open-source:a.two"])
})

test("flags bookkeeping promises but not feature descriptions", (t) => {
  const root = fixture(
    t,
    `  "a.ok": "Download CSV for your bookkeeping",\n  "a.bad": "We handle your bookkeeping for you",\n  "a.bad2": "Fully compliant invoices"`,
    `  "a.ok": "Hent CSV til bogføringen",\n  "a.bad": "Bogføringsklar på ét klik",\n  "a.bad2": "Fuldt ud compliant fakturaer"`
  )
  assert.deepEqual(findings(root).sort(), [
    "bookkeeping-promise:a.bad",
    "bookkeeping-promise:a.bad",
    "bookkeeping-promise:a.bad2",
    "bookkeeping-promise:a.bad2",
  ])
})

test("flags VAT and CVR number in Danish only", (t) => {
  const root = fixture(
    t,
    `  "a.vat": "VAT number",\n  "a.cvr": "CVR number"`,
    `  "a.vat": "VAT-nummer",\n  "a.cvr": "CVR no."`
  )
  assert.deepEqual(findings(root).sort(), ["da-cvr-english:a.cvr", "da-vat:a.vat"])
})

test("parses single-quoted, template and escaped values", (t) => {
  const root = fixture(
    t,
    `  'a.one': 'Quits is open source',\n  "a.two": `+"`Open source`"+`,\n  "a.three": "It\\u0027s open-source"`,
    `  "a.one": "x1",\n  "a.two": "x2",\n  "a.three": "x3"`
  )
  assert.deepEqual(findings(root), ["open-source:a.one", "open-source:a.two", "open-source:a.three"])
})

test("fails explicitly on entries it cannot read", (t) => {
  const root = fixture(t, `  "a.one": "A" + "B"`, `  "a.one": "x"`)
  assert.throws(() => findings(root), /unsupported catalog entry/)
})

test("an opt-out applies to its own entry only", (t) => {
  const root = fixture(
    t,
    [
      `  "a.one": "Open source dependencies", // copy-check: allow open-source names third-party licences`,
      `  "a.next": "Open source",`,
      `  // copy-check: allow open-source quoted from the FSL text`,
      `  "a.two": "Open source",`,
      `  "a.three": "Open source",`,
      `  "a.multi":`,
      `    "Open source", // copy-check: allow open-source quoted from the FSL text`,
      `  "a.after": "Open source",`,
    ].join("\n"),
    [`  "a.one": "x1",`, `  "a.next": "x2",`, `  "a.two": "x3",`, `  "a.three": "x4",`, `  "a.multi": "x5",`, `  "a.after": "x6"`].join("\n")
  )
  assert.deepEqual(findings(root), ["open-source:a.next", "open-source:a.three", "open-source:a.after"])
})

test("a marker needs real reason text, not comment delimiters", (t) => {
  const root = fixture(
    t,
    [
      `  "a.one": "Open source", /* copy-check: allow open-source */`,
      `  "a.two": "Open source", // copy-check: allow open-source`,
      `  "a.three": "Open source", /* copy-check: allow open-source licence text */`,
    ].join("\n"),
    [`  "a.one": "x1",`, `  "a.two": "x2",`, `  "a.three": "x3"`].join("\n")
  )
  assert.deepEqual(findings(root), ["open-source:a.one", "open-source:a.two"])
})

test("scans markdown files with the same opt-out rule", (t) => {
  const root = fixture(t, `  "a.one": "x"`, `  "a.one": "y"`)
  writeFileSync(
    join(root, "COPY.md"),
    [
      "Quits is open source.",
      "<!-- copy-check: allow open-source quoting the old claim -->",
      "Quits is open source.",
      "Quits is open source. <!-- copy-check: allow open-source -->",
    ].join("\n")
  )
  const result = runCopyCheck({ catalogRoot: root, rulesPath, root }).findings.map((f) => `${f.ruleId}:${f.entry.line}`)
  assert.deepEqual(result, ["open-source:1", "open-source:4"])
})
