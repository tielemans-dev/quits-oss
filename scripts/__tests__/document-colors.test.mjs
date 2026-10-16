import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { documentPalette } from "../generate-document-colors.mjs"

const css = readFileSync(new URL("../../apps/oss/src/styles.css", import.meta.url), "utf8")

test("resolves nested light-theme aliases and ignores dark overrides", () => {
  const colors = documentPalette(css.replace("--tone-success: var(--settled-text);", "--tone-success: var(--foreground);"))
  assert.equal(colors.tones.success.text, colors.ink)
  assert.equal(colors.fill, "#f6f6f9")
  assert.equal(colors.paper, "#f7f7fb")
})

test("flattens transparent surfaces and alpha borders onto the panel", () => {
  const colors = documentPalette(css.replace("--hairline: var(--neutral-10);", "--hairline: rgb(0 0 0/50%);"))
  assert.equal(colors.hairline, "#808080")
  assert.equal(colors.settledSoft, "#e9f5ef")
  assert.equal(colors.tones.success.tint, colors.settledSoft)
  assert.equal(colors.tones.danger.tint, "#f5e0e1")
})

test("refuses missing, circular and unsupported tokens instead of keeping stale colors", () => {
  for (const [value, error] of [
    ["var(--missing)", /Missing color token/],
    ["var(--muted)", /Circular color token/],
    ["oklch(0.9 0 0)", /Unsupported color token/],
  ]) {
    assert.throws(() => documentPalette(css.replace("--secondary: var(--neutral-6);", `--secondary: ${value};`)), error)
  }
})
