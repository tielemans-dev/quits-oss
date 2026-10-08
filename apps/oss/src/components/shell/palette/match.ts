/** Lower case, accents folded, so "kreditnota" finds "Kreditnotaer" and "ø" is not special. */
function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
}

/**
 * Items whose label or keywords contain every word of the query, items whose label starts with
 * the query first. An empty query matches everything and keeps the order.
 */
export function matchItems<T extends { label: string; keywords?: string[] }>(items: T[], query: string): T[] {
  const words = fold(query).split(/\s+/).filter(Boolean)
  if (words.length === 0) return items

  const scored: Array<{ item: T; score: number; index: number }> = []
  items.forEach((item, index) => {
    const label = fold(item.label)
    const haystack = [label, ...(item.keywords ?? []).map(fold)].join(' ')
    if (!words.every((word) => haystack.includes(word))) return
    scored.push({ item, score: label.startsWith(words[0]) ? 0 : 1, index })
  })
  return scored.sort((a, b) => a.score - b.score || a.index - b.index).map((entry) => entry.item)
}
