import { readFile, writeFile, stat } from "node:fs/promises"
import { join } from "node:path"

const [directory, phase] = process.argv.slice(2)
if (!directory || !["before", "after"].includes(phase)) throw new Error("Usage: check-qui65-evidence.mjs DIRECTORY before|after")
const screens = ["public-pending", "public-accepted", "admin-invoiced", "admin-draft-invoice", "quote-list", "activity-log", "locale-shell"]
const files = []
for (const locale of ["da-DK", "en-US"]) {
  for (const theme of ["light", "dark"]) {
    for (const viewport of ["desktop", "mobile"]) {
      const suffix = `${locale}-${theme}-${viewport}-${phase}`
      for (const screen of screens) {
        const file = `${screen}-${suffix}.png`
        const bytes = await readFile(join(directory, file))
        if (bytes.length < 1000 || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error(`Missing/invalid screenshot: ${file}`)
        const width = bytes.readUInt32BE(16)
        if (width !== (viewport === "mobile" ? 390 : 1440)) throw new Error(`Wrong screenshot width: ${file}`)
        files.push(file)
      }
      const json = `locale-${suffix}.json`
      const evidence = JSON.parse(await readFile(join(directory, json), "utf8"))
      if (evidence.locale !== locale || evidence.width !== (viewport === "mobile" ? 390 : 1440)) throw new Error(`Wrong locale evidence: ${json}`)
      if (phase === "after" && (evidence.htmlLang !== (locale === "da-DK" ? "da" : "en") || (locale === "da-DK" && (!evidence.serverHasDanishNavigation || evidence.serverHasEnglishNavigation)))) throw new Error(`Locale regression: ${json}`)
      const html = `locale-${suffix}.html`
      if ((await stat(join(directory, html))).size < 1000) throw new Error(`Missing SSR evidence: ${html}`)
      files.push(json, html)
    }
  }
}
const provenance = JSON.parse(await readFile(join(directory, "provenance.json"), "utf8"))
if (!/^[a-f0-9]{40}$/.test(provenance.applicationSha) || !/^[a-f0-9]{40}$/.test(provenance.harnessSha)) throw new Error("Missing exact commit provenance")
await writeFile(join(directory, "manifest.json"), JSON.stringify({ phase, provenance, screenshots: 56, files }, null, 2))
console.log(`Verified ${files.length} evidence files, including 56 screenshots for ${phase}`)
