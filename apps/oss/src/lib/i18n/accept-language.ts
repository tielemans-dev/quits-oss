const SUPPORTED_LOCALES: Record<string, string> = {
  da: "da-DK",
  en: "en-US",
}

/**
 * The locale to answer in when no document is known, from an `Accept-Language` header.
 *
 * A link that no longer resolves to a document has no language of its own, so the visitor's
 * preference is the only signal left. Falls back to English.
 */
export function localeFromAcceptLanguage(header: string | null | undefined): string {
  const candidates = (header ?? "")
    .split(",")
    .map((part, index) => {
      const [tag = "", ...params] = part.trim().split(";")
      const quality = params
        .map((param) => param.trim())
        .find((param) => param.startsWith("q="))
        ?.slice(2)
      const weight = quality === undefined ? 1 : Number(quality)
      return {
        language: tag.trim().toLowerCase().split("-")[0] ?? "",
        weight: Number.isFinite(weight) ? weight : 0,
        index,
      }
    })
    .filter((candidate) => candidate.weight > 0)
    .sort((left, right) => right.weight - left.weight || left.index - right.index)

  for (const { language } of candidates) {
    const locale = SUPPORTED_LOCALES[language]
    if (locale) return locale
  }
  return "en-US"
}
