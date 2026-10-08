import { describe, expect, it } from "vitest"

import { deriveMarkColour, markInitials } from "../mark-colour"

describe("deriveMarkColour", () => {
  it("gives the same name the same colour", () => {
    expect(deriveMarkColour("Fjord & Co.")).toEqual(deriveMarkColour("Fjord & Co."))
  })

  it("ignores case, accents and spacing", () => {
    expect(deriveMarkColour("Åse  Jensen")).toEqual(deriveMarkColour("ase jensen"))
  })

  it("spreads a list of names over the palette", () => {
    const names = ["Fjord & Co.", "Nordlys Studio ApS", "Havnens Bageri", "Åse Jensen", "Bølge Rådgivning", "Tårnby Smede", "Acme", "Globex"]
    const hues = new Set(names.map((name) => deriveMarkColour(name).hue))
    expect(hues.size).toBeGreaterThan(3)
  })
})

describe("markInitials", () => {
  it("takes the first letter of the first two words", () => {
    expect(markInitials("Nordlys Studio ApS")).toBe("NS")
    expect(markInitials("Fjord & Co.")).toBe("FC")
    expect(markInitials("åse jensen")).toBe("ÅJ")
  })

  it("uses one letter for one word and none for an empty name", () => {
    expect(markInitials("Acme")).toBe("A")
    expect(markInitials("  ")).toBe("")
  })
})
