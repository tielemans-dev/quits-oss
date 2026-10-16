import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

import { DURATION, EASE_ENTER, EASE_EXIT, STAGGER_STEP } from "../motion"

const css = readFileSync(new URL("../../motion-tokens.css", import.meta.url), "utf8")
const token = (name: string) => css.match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1]?.trim()
const kebab = (key: string) => key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)

describe("motion tokens", () => {
  it("script and CSS agree on easings", () => {
    expect(token("ease-enter")).toBe(EASE_ENTER)
    expect(token("ease-exit")).toBe(EASE_EXIT)
  })

  it("spatial durations stay within the 350ms spec ceiling", () => {
    // Count-up, tint fade, spinner and pulse move nothing, so they may be longer.
    const nonSpatial = new Set(["count", "highlight", "spin", "pulse"])
    for (const [key, ms] of Object.entries(DURATION)) if (!nonSpatial.has(key)) expect(ms, key).toBeLessThanOrEqual(350)
  })

  it("script and CSS agree on durations", () => {
    for (const [key, ms] of Object.entries(DURATION)) expect(token(`duration-${kebab(key)}`)).toBe(`${ms}ms`)
    expect(css.match(/--duration-[\w-]+:/g)).toHaveLength(Object.keys(DURATION).length)
    expect(token("stagger-step")).toBe(`${STAGGER_STEP}ms`)
  })
})
