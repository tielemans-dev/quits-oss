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
