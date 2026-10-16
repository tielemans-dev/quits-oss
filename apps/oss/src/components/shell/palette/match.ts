/** Lower case, accents folded, so "kreditnota" finds "Kreditnotaer" and "ø" is not special. */
export function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
}

/**
 * Items whose label or keywords contain every word of the query, items whose label starts with
 * the query first. A longer word may lose an ending (-er, -en, -et, -ne), so the verb finds the noun:
 * "fakturer" finds "Ny faktura". Words that only ask ("vis", "mine", "gå til") are left out when
 * others remain. An empty query matches everything and keeps the order.
 */
// Words a sentence asks with ("vis mine kunder", "gå til indstillinger") that name no page.
const FILLER = new Set(['vis', 'se', 'min', 'mit', 'mine', 'alle', 'ga', 'til', 'abn', 'find', 'show', 'my', 'all', 'go', 'to', 'open', 'the'])

export function matchItems<T extends { label: string; keywords?: string[] }>(items: T[], query: string): T[] {
  const typed = fold(query).split(/\s+/).filter(Boolean)
  if (typed.length === 0) return items
  const named = typed.filter((word) => !FILLER.has(word))
  const words = named.length ? named : typed

  const scored: Array<{ item: T; score: number; index: number }> = []
  items.forEach((item, index) => {
    const label = fold(item.label)
    const haystack = [label, ...(item.keywords ?? []).map(fold)].join(' ')
    if (!words.every((word) => haystack.includes(word) || (word.length >= 6 && /(?:er|en|et|ne)$/.test(word) && haystack.includes(word.slice(0, -2))))) return
    scored.push({ item, score: label.startsWith(words[0]) ? 0 : 1, index })
  })
  return scored.sort((a, b) => a.score - b.score || a.index - b.index).map((entry) => entry.item)
}
