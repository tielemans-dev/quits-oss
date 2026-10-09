// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { Amount } from "../amount"

afterEach(cleanup)

const nbsp = " "

function lines(container: HTMLElement) {
  return Array.from(container.querySelectorAll("line"))
}

describe("Amount", () => {
  it.each([1, 0.4])("uses the contrast-safe rule token for paid fraction %s", (paidFraction) => {
    const { container } = render(
      <Amount value="100.00" currency="DKK" rule="double" paidFraction={paidFraction} />
    )
    expect(lines(container)[1].getAttribute("stroke")).toBe("var(--settled-rule)")
  })

  it("keeps the current-colour rule override", () => {
    const { container } = render(<Amount value="100.00" currency="DKK" rule="double" ruleTone="current" />)
    expect(lines(container)[1].getAttribute("stroke")).toBe("currentColor")
  })

  it("reads as the plain amount in the locale, with no superscript element", () => {
    const { container } = render(<Amount value="5600.00" currency="DKK" locale="da-DK" />)
    expect(container.textContent).toBe(`5.600,00${nbsp}kr.`)
    expect(container.querySelector("sup")).toBeNull()
  })

  it("raises the fraction and keeps tabular figures off the separators", () => {
    const { container } = render(<Amount value="5600.00" currency="DKK" locale="da-DK" />)
    const tabular = Array.from(container.querySelectorAll(".tabular-nums")).map((el) => el.textContent)
    expect(tabular).toEqual(["5", "600", "00"])
    const fraction = container.querySelector<HTMLElement>(".relative.tabular-nums")!
    expect(fraction.style.fontSize).toBe("0.68em")
  })

  it("draws no rule for none, one visible rule for single and two for double", () => {
    const none = render(<Amount value="10.00" currency="DKK" locale="da-DK" rule="none" />)
    expect(none.container.querySelector("svg")).toBeNull()
    cleanup()

    const single = render(<Amount value="10.00" currency="DKK" locale="da-DK" rule="single" />)
    const [, second] = lines(single.container)
    // Hidden: the dash is offset past the end of the line.
    expect(second.getAttribute("stroke-dashoffset")).toBe("1")
    cleanup()

    const double = render(<Amount value="10.00" currency="DKK" locale="da-DK" rule="double" />)
    expect(lines(double.container)[1].getAttribute("stroke-dashoffset")).toBe("0")
    expect(lines(double.container)[1].getAttribute("stroke-dasharray")).toBe("1 1")
  })

  it("draws the second rule only as far as the paid fraction", () => {
    const { container } = render(
      <Amount value="100.00" currency="DKK" locale="da-DK" rule="double" paidFraction={0.4} />
    )
    expect(lines(container)[1].getAttribute("stroke-dasharray")).toBe("0.4 1")
    expect(lines(container)[1].getAttribute("stroke-dashoffset")).toBe("0")
  })

  it("animates the second rule, and not under reduced motion", () => {
    const { container } = render(<Amount value="10.00" currency="DKK" locale="da-DK" rule="double" />)
    const className = lines(container)[1].getAttribute("class")!
    expect(className).toContain("transition-[stroke-dashoffset,stroke-dasharray]")
    expect(className).toContain("duration-300")
    expect(className).toContain("motion-reduce:transition-none")
  })

  it("keeps the rules out of what a screen reader gets, and adds a status when given one", () => {
    const { container } = render(
      <Amount value="10.00" currency="DKK" locale="da-DK" rule="double" statusLabel="Betalt" />
    )
    expect(container.querySelector("svg")!.getAttribute("aria-hidden")).toBe("true")
    expect(container.querySelector(".sr-only")!.textContent).toBe(", Betalt")
  })

  it("shows an em dash, and no rule, for an amount that could not be written down", () => {
    const { container } = render(<Amount value={null} currency="DKK" locale="da-DK" rule="double" />)
    expect(container.textContent).toBe("—")
    expect(container.querySelector("svg")).toBeNull()
  })

  it("takes minor units", () => {
    const { container } = render(<Amount value={{ minor: 4825000 }} currency="DKK" locale="da-DK" />)
    expect(container.textContent).toBe(`48.250,00${nbsp}kr.`)
  })
})
