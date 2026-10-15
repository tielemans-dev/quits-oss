import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// Proposed scales recorded by Ines on QUI-66. Report only until policy approval.
const sizes = new Set([11, 12, 14, 16, 18, 20, 24, 30])
const spacing = new Set([0, 1, 2, 4, 6, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80])
const weights = new Set([400, 500, 700, 800])
export function checkDesign(source, file) {
  const findings = []
  const report = (match, rule) => findings.push({ file, line: source.slice(0, match.index).split('\n').length, rule, value: match[0] })
  if (file === 'styles.css') {
    for (const category of ['color', 'text', 'spacing', 'radius', 'font', 'font-weight']) {
      if (!source.includes(`--${category}-*: initial;`)) findings.push({ file, line: 1, rule: 'theme-reset-missing', value: category })
    }
    return findings
  }
  for (const match of source.matchAll(/(?:fontSize\s*:\s*|font-size\s*:\s*)(\d+(?:\.\d+)?)(?:px|pt)?\b/g)) {
    if (!sizes.has(Number(match[1]))) report(match, 'font-size')
  }
  for (const match of source.matchAll(/(?:fontWeight|font-weight)\s*:\s*["']?(\d{3})/g)) {
    if (!weights.has(Number(match[1]))) report(match, 'font-weight')
  }
  for (const match of source.matchAll(/(?:padding|margin)(?:Top|Right|Bottom|Left)?\s*:\s*(\d+)\b/g)) {
    if (!spacing.has(Number(match[1]))) report(match, 'spacing')
  }
  for (const match of source.matchAll(/borderRadius\s*:\s*(\d+)\b/g)) {
    if (![0, 6, 8, 10, 12, 9999].includes(Number(match[1]))) report(match, 'radius')
  }
  // Grid templates are intentionally allowed. Tokens remain the colour authority.
  for (const match of source.matchAll(/(?:text|bg|border|p[trblxy]?|m[trblxy]?|gap|rounded)-\[[^\]]+\]|#[\da-f]{6}\b/gi)) report(match, 'one-off-value')
  for (const match of source.matchAll(/fontFamily\s*:\s*["']Helvetica[^"']*["']/g)) report(match, 'pdf-font')
  return findings
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../apps/oss/src', import.meta.url))
  const findings = []
  function scan(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory() && !['__tests__', 'test-utils', 'i18n', 'brand'].includes(entry.name)) scan(file)
      else if (entry.isFile() && /\.(tsx?|css)$/.test(entry.name)) {
        findings.push(...checkDesign(readFileSync(file, 'utf8'), path.relative(root, file)))
      }
    }
  }
  scan(root)
  console.log(JSON.stringify({ mode: 'report-only', findings }, null, 2))
}
