// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { QuitsMark } from "../quits-mark"

afterEach(cleanup)

describe("QuitsMark", () => {
  it("is a decorative brand tile with a q and the green full stop", () => {
    const { container } = render(<QuitsMark />)
    const svg = container.querySelector("svg")!

    expect(svg.getAttribute("aria-hidden")).toBe("true")
    expect(svg.getAttribute("viewBox")).toBe("0 0 32 32")
    const tile = svg.querySelector("rect[rx='7']") as SVGRectElement
    expect(tile.style.fill).toBe("var(--brand)")
    // The stop is a square on whole pixels, always Settled green.
    const stop = svg.querySelector("rect[x='21'][y='17'][width='4'][height='4']") as SVGRectElement
    expect(stop.style.fill).toBe("var(--settled)")
  })

  it("takes a size and other props from the caller", () => {
    const { container } = render(<QuitsMark className="size-7" data-testid="mark" />)
    const svg = container.querySelector("svg")!

    expect(svg.getAttribute("class")).toContain("size-7")
    expect(svg.getAttribute("class")).not.toContain("size-8")
    expect(svg.getAttribute("data-testid")).toBe("mark")
  })
})
