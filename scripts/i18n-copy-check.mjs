#!/usr/bin/env node
// Copy gates: Danish values left identical to English, and glossary wording rules.
// Rules and allowlists live in scripts/i18n/copy-rules.json. Key parity is in i18n-check.mjs.
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, "..")
const defaultCatalogRoot = path.join(repoRoot, "apps/oss/src/lib/i18n/catalog")
const defaultRulesPath = path.join(scriptDir, "i18n/copy-rules.json")

const entryRegex = /"((?:[^"\\]|\\.)*)"\s*:\s*("(?:[^"\\]|\\.)*"|`(?:[^`\\$]|\\.)*`)/g
const optOutRegex = /copy-check:\s*allow\s+([a-z0-9-]+)(?:\s+(\S.*?))?\s*(?:\*\/|-->)?\s*$/

/** Entries of one catalog file with their 1-based line, for opt-out lookups. */
export function parseCatalogSource(source) {
  const entries = []
  for (const match of source.matchAll(entryRegex)) {
    const raw = match[2]
    const value = raw.startsWith("`") ? raw.slice(1, -1) : JSON.parse(raw)
    const line = source.slice(0, match.index).split("\n").length
    entries.push({ key: match[1], value, line })
  }
  return entries
}

export function loadCatalog(catalogRoot, language) {
  const dir = path.join(catalogRoot, language)
  const entries = new Map()
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith(".ts") || name === "index.ts") continue
    const file = path.join(dir, name)
    const source = fs.readFileSync(file, "utf8")
    const lines = source.split("\n")
    for (const entry of parseCatalogSource(source)) {
      entries.set(entry.key, { ...entry, file, lines })
    }
  }
  return entries
}

/** Opt-out marker on the entry's line or the one above. Returns { ruleId, reason } or null. */
function findOptOut(lines, line, ruleId) {
  for (const text of [lines[line - 1], lines[line - 2]]) {
    const match = text?.match(optOutRegex)
    if (match && match[1] === ruleId) return { ruleId, reason: match[2]?.trim() ?? "" }
  }
  return null
}

function stripNonWords(value) {
  return value.replace(/\{[^}]*\}/g, "").replace(/https?:\/\/\S+/g, "")
}

export function checkUntranslated({ en, da }, config) {
  const allowed = new Set(config.untranslated.allowValues.map((item) => item.value))
  const findings = []
  for (const [key, entry] of da) {
    const english = en.get(key)
    if (!english || english.value !== entry.value) continue
    const letters = stripNonWords(entry.value).replace(/[^\p{L}]/gu, "")
    if (letters.length <= 3 || allowed.has(entry.value)) continue
    findings.push({
      ruleId: "untranslated",
      key,
      entry,
      message: `Danish value is identical to English (${JSON.stringify(entry.value)}). Translate it, or add it to untranslated.allowValues in scripts/i18n/copy-rules.json with a reason.`,
    })
  }
  return findings
}

export function checkRules(catalogs, config) {
  const findings = []
  for (const rule of config.rules) {
    const regex = new RegExp(rule.pattern, rule.flags ?? "")
    for (const language of rule.langs) {
      for (const [key, entry] of catalogs[language] ?? []) {
        if (regex.test(entry.value)) {
          findings.push({ ruleId: rule.id, key, entry, language, message: `${rule.message} (${JSON.stringify(entry.value)})` })
        }
      }
    }
  }
  return findings
}

export function checkMarkdownFiles(root, config) {
  const findings = []
  for (const rule of config.rules.filter((item) => item.langs.includes("en"))) {
    const regex = new RegExp(rule.pattern, rule.flags ?? "")
    for (const name of config.files) {
      const file = path.join(root, name)
      if (!fs.existsSync(file)) continue
      const lines = fs.readFileSync(file, "utf8").split("\n")
      lines.forEach((text, index) => {
        if (!regex.test(text)) return
        const entry = { file, line: index + 1, lines, value: text.trim() }
        findings.push({ ruleId: rule.id, key: name, entry, message: `${rule.message} (${JSON.stringify(entry.value)})` })
      })
    }
  }
  return findings
}

/** Drops findings with a valid inline opt-out. A marker without a reason is itself reported. */
export function applyOptOuts(findings) {
  const reported = []
  for (const finding of findings) {
    const optOut = findOptOut(finding.entry.lines, finding.entry.line, finding.ruleId)
    if (!optOut) reported.push(finding)
    else if (!optOut.reason) reported.push({ ...finding, message: `copy-check: allow ${finding.ruleId} needs a reason. ${finding.message}` })
  }
  return reported
}

export function runCopyCheck({ catalogRoot = defaultCatalogRoot, rulesPath = defaultRulesPath, root = repoRoot } = {}) {
  const config = JSON.parse(fs.readFileSync(rulesPath, "utf8"))
  const catalogs = { en: loadCatalog(catalogRoot, "en"), da: loadCatalog(catalogRoot, "da") }
  const findings = applyOptOuts([
    ...checkUntranslated(catalogs, config),
    ...checkRules(catalogs, config),
    ...checkMarkdownFiles(root, config),
  ])
  return { findings, keys: catalogs.en.size }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { findings, keys } = runCopyCheck()
  if (findings.length > 0) {
    console.error(`i18n copy-check failed with ${findings.length} finding(s):`)
    for (const { entry, ruleId, key, message } of findings) {
      console.error(`  ${path.relative(repoRoot, entry.file)}:${entry.line} [${ruleId}] ${key}: ${message}`)
    }
    console.error(
      "Fix the copy, or opt out inline with `// copy-check: allow <rule-id> <reason>` (see scripts/i18n/copy-rules.json)."
    )
    process.exit(1)
  }
  console.log(`i18n copy-check ok. Keys checked: ${keys}.`)
}
