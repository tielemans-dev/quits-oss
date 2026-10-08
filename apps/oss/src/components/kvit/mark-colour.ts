/**
 * A stable mark colour for a name. Contacts have no colour of their own yet, so the mark is
 * derived: the same name always gets the same colour, in every session and on every screen.
 *
 * This is a mark colour, not a customer's brand colour. When contacts can carry a real colour,
 * pass it to `CustomerMark` through `markColour` and this derivation becomes the fallback.
 */

/**
 * Hand-picked hues for OKLCH at the lightness `CustomerMark` sets. Chroma stays low so a long
 * list reads as a quiet range, not a rainbow, and the hues stay clear of the success green, the
 * danger red and the Kvit-blå violet, which carry meaning.
 */
const palette = [
  { hue: 45, chroma: 0.085 }, // clay
  { hue: 75, chroma: 0.085 }, // ochre
  { hue: 110, chroma: 0.08 }, // moss
  { hue: 175, chroma: 0.075 }, // teal
  { hue: 205, chroma: 0.085 }, // lagoon
  { hue: 235, chroma: 0.095 }, // steel
  { hue: 320, chroma: 0.09 }, // plum
  { hue: 350, chroma: 0.095 }, // rose
] as const

export type MarkColour = (typeof palette)[number]

/** FNV-1a over the name, folded to case, accents and spacing, so "Åse  Jensen" and "ase jensen" agree. */
function hashName(name: string): number {
  const folded = name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
  let hash = 0x811c9dc5
  for (let i = 0; i < folded.length; i += 1) {
    hash ^= folded.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

export function deriveMarkColour(name: string): MarkColour {
  return palette[hashName(name) % palette.length]
}

/** Up to two initials, upper-cased without the host locale (a Turkish "i" must not become "İ" on one machine only); from the first two words that start with a letter or digit; "Fjord & Co." is "FC". */
export function markInitials(name: string): string {
  const words = name
    .trim()
    .split(/\s+/)
    .map((word) => Array.from(word).find((char) => /[\p{L}\p{N}]/u.test(char)))
    .filter((char): char is string => Boolean(char))
  return words.slice(0, 2).join("").toUpperCase()
}
