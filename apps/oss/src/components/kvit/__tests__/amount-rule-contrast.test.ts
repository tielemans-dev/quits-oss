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
    expect(token(light, "settled-rule")).toBe("#21a15a")
    expect(contrast(token(light, "settled-rule"), token(light, surface))).toBeGreaterThanOrEqual(3)
  })

  it.each(["canvas", "panel", "panel-raised"])("keeps the paid rule visible on dark --%s", (surface) => {
    const dark = themeTokens(".dark")
    expect(contrast(token(dark, "settled-rule"), token(dark, surface))).toBeGreaterThanOrEqual(3)
  })
})
