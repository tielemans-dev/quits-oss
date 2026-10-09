import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { documentColors } from "../document-colors"

// Emails and PDFs cannot read CSS variables, so they carry copies. This keeps the copies honest.
const css = readFileSync(new URL("../../../styles.css", import.meta.url), "utf8")
const lightTheme = css.slice(css.indexOf(":root {"), css.indexOf("}", css.indexOf(":root {")))
const token = (name: string) => lightTheme.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "i"))?.[1]?.toLowerCase()

describe("documentColors", () => {
  it.each([
    ["paper", "canvas"],
    ["panel", "panel"],
    ["ink", "foreground"],
    ["muted", "muted-foreground"],
    ["fill", "muted"],
    ["settled", "settled"],
    ["settledText", "settled-text"],
    ["settledSoft", "settled-soft"],
  ] as const)("%s matches --%s", (key, variable) => {
    expect(documentColors[key]).toBe(token(variable))
  })

  it.each(["neutral", "info", "success", "danger"] as const)("the %s tone matches --tone-%s", (tone) => {
    expect(documentColors.tones[tone].text).toBe(token(`tone-${tone}`))
  })
})
