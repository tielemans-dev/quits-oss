import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const css = readFileSync(new URL("../../../styles.css", import.meta.url), "utf8")
const themeTokens = (selector: string) => {
  const start = css.indexOf(`${selector} {`)
  return css.slice(start, css.indexOf("}", start))
}
const token = (theme: string, name: string) => {
  const value = theme.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "i"))?.[1]
  if (!value) throw new Error(`Missing hex token --${name}`)
  return value
}
function luminance(hex: string) {
  const [r, g, b] = [1, 3, 5].map((offset) => {
    const channel = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
function contrast(first: string, second: string) {
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a)
  return (values[0] + 0.05) / (values[1] + 0.05)
}

describe("paid amount rule contrast", () => {
  it.each(["canvas", "panel", "panel-raised"])("keeps the paid rule above 3:1 on light --%s", (surface) => {
    const light = themeTokens(":root")
    expect(token(light, "settled-rule")).toBe("#1f9d5c")
    expect(contrast(token(light, "settled-rule"), token(light, surface))).toBeGreaterThanOrEqual(3)
  })

  it.each(["canvas", "panel", "panel-raised"])("keeps the paid rule visible on dark --%s", (surface) => {
    const dark = themeTokens(".dark")
    expect(contrast(token(dark, "settled-rule"), token(dark, surface))).toBeGreaterThanOrEqual(3)
  })
})

describe("Papir and Blæk text contrast", () => {
  it.each([":root", ".dark"])("keeps text AA on %s surfaces", selector => {
    const theme = themeTokens(selector)
    for (const surface of ["canvas", "panel", "panel-raised", "secondary", "main-bg"]) {
      for (const text of ["foreground", "muted-foreground", "brand-text", "settled-text", "tone-warning"]) {
        expect(contrast(token(theme, text), token(theme, surface)), `${text} on ${surface}`).toBeGreaterThanOrEqual(4.5)
      }
    }
    expect(contrast(token(theme, "brand-foreground"), token(theme, "brand"))).toBeGreaterThanOrEqual(4.5)
  })
})
