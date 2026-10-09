import type { TranslationKey } from "../../lib/i18n/messages"

export type Translate = (key: TranslationKey, vars?: Record<string, string | number>) => string

/** A message with a singular and a plural form: `<base>.one` for 1, `<base>.other` for the rest. */
export function tCount(
  t: Translate,
  base: string,
  count: number,
  vars: Record<string, string | number> = {}
): string {
  return t(`${base}.${count === 1 ? "one" : "other"}` as TranslationKey, { count, ...vars })
}
