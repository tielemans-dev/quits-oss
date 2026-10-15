import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import assert from "node:assert/strict"

const dir = process.argv[2]
assert(dir, "Capture directory is required")
const manifest = JSON.parse(readFileSync(resolve(dir, "manifest.json"), "utf8"))
assert.equal(manifest.applicationSha, process.env.ONB121_HEAD, "Evidence must match exact PR head")
assert.equal(manifest.onboardingMode, "legacy-manual-v2-off")
assert.equal(manifest.initialSettingsPersisted, true, "The first legacy RPC read must persist Danish settings")
assert.equal(manifest.localeFixture, "locale-only-override-after-first-read-persistence")
assert.equal(manifest.images.length, 8, "Expected four initial and four post-submit screenshots")
for (const locale of ["da-DK", "en-US"]) {
  for (const width of [390, 1440]) {
    for (const state of ["fresh-initial", "invalid-submit"]) {
      const file = `${locale}-${width}-${state}.png`
      const entries = manifest.images.filter(image => image.file === file)
      assert.equal(entries.length, 1, `Missing or duplicate ${file}`)
      const entry = entries[0]
      assert.equal(entry.countryCode, "DK")
      assert.equal(entry.defaultCurrency, "DKK")
      assert.equal(entry.taxRegime, "eu_vat")
      assert.equal(entry.locale, locale)
      assert.equal(entry.width, width)
      assert.equal(entry.state, state)
      assert.equal(new URL(entry.url).pathname, "/onboarding")
      assert.equal(entry.validation, state === "fresh-initial" ? null : locale === "da-DK"
        ? "Udfyld virksomhedsnavn, adresse og e-mail for at fortsætte."
        : "Fill in company name, address and email to continue.")
      const png = readFileSync(resolve(dir, file))
      assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a")
      assert.equal(png.readUInt32BE(16), width, `Wrong width: ${file}`)
      assert(png.readUInt32BE(20) >= 1000, `Truncated full-page capture: ${file}`)
      console.log(`${file}: ${width}x${png.readUInt32BE(20)}`)
    }
  }
}
console.log(`Verified eight actual-app captures for ${manifest.applicationSha}`)
