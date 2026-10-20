// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { ListSkeleton } from "../list"

afterEach(cleanup)

const rows = (container: HTMLElement) => container.querySelector("[data-slot=list-skeleton] > [aria-hidden]")!

describe("ListSkeleton", () => {
  it("stays inside its parent by default, as in a card or a form field", () => {
    const { container } = render(<ListSkeleton label="Indlæser" />)
    expect(rows(container).className).not.toContain("-mx-3")
  })

  it("reaches past the column like a list table when asked to", () => {
    const { container } = render(<ListSkeleton label="Indlæser" bleed />)
    expect(rows(container).className).toContain("-mx-3")
  })
})
