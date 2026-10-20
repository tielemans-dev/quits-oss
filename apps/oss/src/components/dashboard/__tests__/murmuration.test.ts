import { describe, expect, it } from "vitest"

import { createMurmuration } from "../murmuration"

/** A canvas whose 2D context records the glyphs and cells drawn on it. */
function fakeCanvas() {
  const glyphs: Array<{ x: number; y: number }> = []
  const cells: Array<{ x: number; y: number }> = []
  const context = {
    setTransform() {},
    clearRect() {
      glyphs.length = 0
      cells.length = 0
    },
    fillRect(x: number, y: number) {
      cells.push({ x, y })
    },
    fillText(_glyph: string, x: number, y: number) {
      glyphs.push({ x, y })
    },
  }
  const canvas = { width: 0, height: 0, getContext: () => context } as unknown as HTMLCanvasElement
  return { canvas, glyphs, cells }
}

describe("murmuration", () => {
  it("draws the flock as glyphs and tinted cells, the same way on every visit", () => {
    const first = fakeCanvas()
    const second = fakeCanvas()
    for (const { canvas } of [first, second]) {
      const flock = createMurmuration(canvas)!
      flock.resize(1000, 360, 2)
      flock.still()
    }
    expect(first.canvas.width).toBe(2000)
    expect(first.glyphs.length).toBeGreaterThan(100)
    expect(first.cells.length).toBeGreaterThan(20)
    expect(second.glyphs).toEqual(first.glyphs)
  })

  it("keeps the words over it legible: no tinted cells in the middle of the clear zone", () => {
    const open = fakeCanvas()
    const cleared = fakeCanvas()
    const zone = { x: 500, y: 180, rx: 500, ry: 180 }
    for (const [{ canvas }, clear] of [[open, null], [cleared, zone]] as const) {
      const flock = createMurmuration(canvas)!
      flock.resize(1000, 360, 1)
      flock.setClear(clear)
      flock.still()
    }
    const inside = (cells: Array<{ x: number; y: number }>) =>
      cells.filter(({ x, y }) => ((x - 500) / 360) ** 2 + ((y - 180) / 130) ** 2 < 1).length
    expect(inside(open.cells)).toBeGreaterThan(0)
    expect(inside(cleared.cells)).toBe(0)
  })

  it("scatters from the pointer and closes up again when it leaves", () => {
    const chased = fakeCanvas()
    const calm = fakeCanvas()
    const [flock, control] = [chased, calm].map(({ canvas }) => {
      const each = createMurmuration(canvas)!
      each.resize(1000, 360, 1)
      each.still()
      return each
    })
    const near = (glyphs: Array<{ x: number; y: number }>, point: { x: number; y: number }) =>
      glyphs.filter(({ x, y }) => Math.hypot(x - point.x, y - point.y) < 30).length
    // Aim at the densest part of the flock.
    const target = chased.glyphs.reduce((best, glyph) => (near(chased.glyphs, glyph) > near(chased.glyphs, best) ? glyph : best))

    flock!.setPointer(target)
    for (let frame = 0; frame < 15; frame++) {
      flock!.tick(1 / 30)
      control!.tick(1 / 30)
    }
    expect(near(chased.glyphs, target)).toBeLessThan(near(calm.glyphs, target) / 2)

    flock!.setPointer(null)
    for (let frame = 0; frame < 150; frame++) {
      flock!.tick(1 / 30)
      control!.tick(1 / 30)
    }
    expect(chased.glyphs).toEqual(calm.glyphs)
  })

  it("does nothing without a 2D context", () => {
    const canvas = { getContext: () => null } as unknown as HTMLCanvasElement
    expect(createMurmuration(canvas)).toBeNull()
  })
})
