import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { documentPalette } from "../generate-document-colors.mjs"

const css = readFileSync(new URL("../../apps/oss/src/styles.css", import.meta.url), "utf8")

test("resolves nested light-theme aliases and ignores dark overrides", () => {
  const colors = documentPalette(css.replace("--brand-text: #4b50cc;", "--brand-text: var(--foreground);"))
  assert.equal(colors.tones.success.text, colors.ink)
  assert.equal(colors.fill, "#efeee9")
  assert.equal(colors.paper, "#faf9f6")
})

test("flattens transparent surfaces and alpha borders onto the panel", () => {
  const colors = documentPalette(css.replace("--hairline: rgb(120 114 100/13%);", "--hairline: rgb(0 0 0/50%);"))
  assert.equal(colors.hairline, "#808080")
  assert.equal(colors.settledSoft, colors.panel)
  assert.equal(colors.tones.success.tint, colors.settledSoft)
  assert.equal(colors.tones.danger.tint, "#f5e0e1")
})

test("refuses missing, circular and unsupported tokens instead of keeping stale colors", () => {
  for (const [value, error] of [
    ["var(--missing)", /Missing color token/],
    ["var(--muted)", /Circular color token/],
    ["oklch(0.9 0 0)", /Unsupported color token/],
  ]) {
    assert.throws(() => documentPalette(css.replace("--secondary: #efeee9;", `--secondary: ${value};`)), error)
  }
})
