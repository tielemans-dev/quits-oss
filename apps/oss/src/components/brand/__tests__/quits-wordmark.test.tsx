// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { QuitsWordmark } from "../quits-wordmark"

afterEach(cleanup)

describe("QuitsWordmark", () => {
  it("reads as the word quits and takes its size from the caller", () => {
    const { container } = render(<QuitsWordmark className="text-xl" />)
    const word = container.querySelector("span")!

    expect(word.textContent).toBe("quits")
    expect(word.getAttribute("class")).toContain("text-xl")
  })
})
