// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { QuitsMark } from "../quits-mark"

afterEach(cleanup)

describe("QuitsMark", () => {
  it("is a decorative tile in the current colour with the q cut out", () => {
    const { container } = render(<QuitsMark />)
    const svg = container.querySelector("svg")!

    expect(svg.getAttribute("aria-hidden")).toBe("true")
    expect(svg.getAttribute("viewBox")).toBe("0 0 32 32")
    const tile = svg.querySelector("rect[rx='8']")!
    expect(tile.getAttribute("fill")).toBe("currentColor")
    expect(tile.getAttribute("mask")).toMatch(/^url\(#quits-mark-.+\)$/)
  })

  it("gives each mark its own mask so several can share a page", () => {
    const { container } = render(
      <>
        <QuitsMark />
        <QuitsMark />
      </>
    )
    const ids = [...container.querySelectorAll("mask")].map((mask) => mask.id)

    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
    for (const id of ids) expect(id).toMatch(/^[a-zA-Z0-9_-]+$/)
  })

  it("takes a size and other props from the caller", () => {
    const { container } = render(<QuitsMark className="size-7" data-testid="mark" />)
    const svg = container.querySelector("svg")!

    expect(svg.getAttribute("class")).toContain("size-7")
    expect(svg.getAttribute("class")).not.toContain("size-8")
    expect(svg.getAttribute("data-testid")).toBe("mark")
  })
})
