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

const optOutRegex = /^\s*copy-check:\s*allow\s+([a-z0-9-]+)\s*(.*?)\s*$/s
const escapes = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", 0: "\0" }

function unescapeString(body) {
  return body.replace(/\\(?:u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|(\r?\n)|(.))/gs, (_m, cp, u, x, newline, char) => {
    if (cp || u || x) return String.fromCodePoint(parseInt(cp ?? u ?? x, 16))
    if (newline !== undefined) return ""
    return escapes[char] ?? char
  })
}

/** Comment body without its delimiters, for markers. */
function commentBody(text) {
  return text.startsWith("//") ? text.slice(2) : text.slice(2, -2)
}

/** Splits TypeScript source into strings, comments, punctuation and words. Unterminated input throws. */
function tokenize(source, file) {
  const tokens = []
  let i = 0
  const lineAt = (offset) => source.slice(0, offset).split("\n").length
  while (i < source.length) {
    const char = source[i]
    if (/\s/.test(char)) {
      i += 1
    } else if (source.startsWith("//", i)) {
      const end = source.indexOf("\n", i)
      const stop = end === -1 ? source.length : end
      tokens.push({ type: "comment", start: i, end: stop, text: source.slice(i, stop) })
      i = stop
    } else if (source.startsWith("/*", i)) {
      const end = source.indexOf("*/", i + 2)
      if (end === -1) throw new Error(`${file}:${lineAt(i)}: unterminated comment`)
      tokens.push({ type: "comment", start: i, end: end + 2, text: source.slice(i, end + 2) })
      i = end + 2
    } else if (char === '"' || char === "'" || char === "`") {
      let j = i + 1
      while (j < source.length && source[j] !== char) {
        if (source[j] === "\\") j += 1
        else if (char === "`" && source.startsWith("${", j)) throw new Error(`${file}:${lineAt(j)}: template with \${} is not supported in catalogs`)
        else if (char !== "`" && source[j] === "\n") break
        j += 1
      }
      if (source[j] !== char) throw new Error(`${file}:${lineAt(i)}: unterminated string`)
      tokens.push({ type: "string", start: i, end: j + 1, value: unescapeString(source.slice(i + 1, j)) })
      i = j + 1
    } else if (/[\p{L}\p{N}_$]/u.test(char)) {
      let j = i + 1
      while (j < source.length && /[\p{L}\p{N}_$]/u.test(source[j])) j += 1
      tokens.push({ type: "word", start: i, end: j, value: source.slice(i, j) })
      i = j
    } else {
      tokens.push({ type: "punct", start: i, end: i + 1, value: char })
      i += 1
    }
  }
  return tokens
}

/**
 * Entries of one catalog file: the first object literal after `=`. Every entry must be
 * `key: "string",` in any string form (", ' or static backtick); anything else throws.
 * Each entry carries the opt-outs attached to it alone.
 */
export function parseCatalogSource(source, file = "catalog") {
  const tokens = tokenize(source, file)
  const lineAt = (offset) => source.slice(0, offset).split("\n").length
  const code = tokens.filter((token) => token.type !== "comment")
  const open = code.findIndex((token, index) => token.value === "{" && code[index - 1]?.value === "=")
  if (open === -1) throw new Error(`${file}: no catalog object literal found`)

  const entries = []
  let i = open + 1
  while (code[i] && code[i].value !== "}") {
    const [key, colon, value, after] = code.slice(i, i + 4)
    const fail = (token) => new Error(`${file}:${lineAt((token ?? key).start)}: unsupported catalog entry, expected "key": "string",`)
    if (!key || !["string", "word"].includes(key.type) || colon?.value !== ":") throw fail(key)
    if (value?.type !== "string") throw fail(value)
    if (after && after.value !== "," && after.value !== "}") throw fail(after)
    const end = after?.value === "," ? after.end : value.end
    entries.push({ key: key.value, value: value.value, line: lineAt(key.start), startLine: lineAt(key.start), endLine: lineAt(value.end), start: key.start, end, optOuts: [] })
    i += after?.value === "," ? 4 : 3
  }
  if (!code[i]) throw new Error(`${file}: catalog object literal is not closed`)

  const lineStart = (offset) => source.lastIndexOf("\n", offset - 1) + 1
  for (const comment of tokens.filter((token) => token.type === "comment")) {
    const marker = commentBody(comment.text).match(optOutRegex)
    if (!marker) continue
    const standalone = source.slice(lineStart(comment.start), comment.start).trim() === ""
    const startLine = lineAt(comment.start)
    const endLine = lineAt(comment.end)
    const owner = standalone
      ? entries.find((entry) => entry.startLine === endLine + 1)
      : entries.find((entry) => entry.start < comment.start && comment.start < entry.end) ??
        entries.filter((entry) => entry.end <= comment.start && entry.endLine === startLine).at(-1)
    owner?.optOuts.push({ ruleId: marker[1], reason: marker[2] })
  }
  return entries
}

export function loadCatalog(catalogRoot, language) {
  const dir = path.join(catalogRoot, language)
  const entries = new Map()
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith(".ts") || name === "index.ts") continue
    const file = path.join(dir, name)
    for (const entry of parseCatalogSource(fs.readFileSync(file, "utf8"), path.relative(repoRoot, file))) {
      entries.set(entry.key, { ...entry, file })
    }
  }
  return entries
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
      const marker = (text) => text?.match(/<!--(.*?)-->/)?.[1].match(optOutRegex)
      lines.forEach((text, index) => {
        if (!regex.test(text)) return
        // A marker applies to its own line, or to a line holding only the marker directly above.
        const above = lines[index - 1]?.trim().startsWith("<!--") && lines[index - 1].trim().endsWith("-->") ? marker(lines[index - 1]) : null
        const optOuts = [marker(text), above].filter(Boolean).map((found) => ({ ruleId: found[1], reason: found[2] }))
        const entry = { file, line: index + 1, value: text.trim(), optOuts }
        findings.push({ ruleId: rule.id, key: name, entry, message: `${rule.message} (${JSON.stringify(entry.value)})` })
      })
    }
  }
  return findings
}

/** Drops findings with a valid inline opt-out. A marker without real reason text is itself reported. */
export function applyOptOuts(findings) {
  const reported = []
  for (const finding of findings) {
    const optOut = finding.entry.optOuts.find((item) => item.ruleId === finding.ruleId)
    if (!optOut) reported.push(finding)
    else if (optOut.reason.replace(/[^\p{L}\p{N}]/gu, "").length < 3) {
      reported.push({ ...finding, message: `copy-check: allow ${finding.ruleId} needs a reason. ${finding.message}` })
    }
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
