/** A field on the page that hands what was typed to the palette, which then grows out of it. */
export type PaletteOpen = { from: Element; query: string }

const openers = new Set<(open: PaletteOpen) => void>()

export function onPaletteOpen(listener: (open: PaletteOpen) => void): () => void {
  openers.add(listener)
  return () => void openers.delete(listener)
}

export function openPaletteFrom(open: PaletteOpen) {
  for (const listener of openers) listener(open)
}

const returners = new Set<(query: string) => void>()

/** The palette gave up over the field it grew out of (Esc, a click outside): the field takes the text back. */
export function onPaletteReturn(listener: (query: string) => void): () => void {
  returners.add(listener)
  return () => void returners.delete(listener)
}

export function returnFromPalette(query: string) {
  for (const listener of returners) listener(query)
}
