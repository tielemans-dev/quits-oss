// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { QuitsWordmark } from "../quits-wordmark"

afterEach(cleanup)

describe("QuitsWordmark", () => {
  it("reads as the word quits and takes its size from the caller", () => {
    const { container } = render(<QuitsWordmark className="text-xl" />)
    const word = container.querySelector("svg")!

    expect(word.getAttribute("role")).toBe("img")
    expect(word.getAttribute("aria-label")).toBe("quits")
    expect(word.getAttribute("class")).toContain("text-xl")
    expect(word.getAttribute("class")).toContain("h-[1em]")
  })

  it("draws the full stop in Settled green and the letters in the text colour", () => {
    const { container } = render(<QuitsWordmark />)
    const svg = container.querySelector("svg")!
    const paths = svg.querySelectorAll("path")

    expect(svg.getAttribute("fill")).toBe("currentColor")
    expect((paths[paths.length - 1] as SVGPathElement).style.fill).toBe("var(--settled)")
  })
})
