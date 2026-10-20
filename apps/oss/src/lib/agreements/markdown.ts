import MarkdownIt from "markdown-it"
import sanitizeHtml from "sanitize-html"
import { formatCurrency, formatDate } from "../i18n/format"

const markdown = new MarkdownIt({ html: false, linkify: false, typographer: false })
markdown.disable("image")
markdown.validateLink = (url) =>
  /^(https?:\/\/|mailto:)/i.test(url) &&
  !Array.from(url).some((character) => character.charCodeAt(0) <= 32)

/** Escape Markdown syntax and HTML before substituting untrusted snapshot values. */
export function escapeAgreementPlaceholder(value: string) {
  return value
    .replace(/[\\`*_{}[\]()#+\-.!|~]/g, "\\$&")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

/** The total and validity date as the terms state them: in the agreement's language, not as stored values. */
export function agreementTermsAmounts(input: { total: number | string | null; currency: string; validUntil: Date | string | null; locale: string }) {
  return {
    // A currency code still being typed in the editor has no format yet.
    "agreement.total": input.total === null || input.total === "" ? ""
      : /^[A-Za-z]{3}$/.test(input.currency.trim()) ? formatCurrency(Number(input.total), input.currency, input.locale) : `${input.total} ${input.currency}`,
    // A calendar date, shown as written rather than shifted by a timezone.
    "agreement.validUntil": input.validUntil ? formatDate(input.validUntil, input.locale, "UTC", { month: "long" }) : "",
  }
}

/** Leaves out each sentence that names one of these placeholders, so a draft preview never reads "valid until ." */
export function omitSentencesNaming(source: string, keys: readonly string[]) {
  const tokens = keys.map(key => `{{${key}}}`)
  return source.split("\n").map(line => line.split(/(?<=[.!?])[ \t]+/)
    .filter(sentence => !tokens.some(token => sentence.includes(token))).join(" ")).join("\n")
}

export function renderAgreementMarkdown(source: string, placeholders: Record<string, string> = {}) {
  if (source.length > 50_000) throw new Error("Agreement terms must be at most 50,000 characters")
  const expanded = source.replace(/\{\{([a-zA-Z.]+)\}\}/g, (token, key: string, offset: number) => {
    if (!Object.hasOwn(placeholders, key)) return token
    const value = placeholders[key]!
    // A value ending in a period, such as "kr.", ends the sentence too: never "22.500,00 kr.."
    return escapeAgreementPlaceholder(value.endsWith(".") && source[offset + token.length] === "." ? value.slice(0, -1) : value)
  })
  if (expanded.length > 50_000)
    throw new Error("Expanded agreement terms must be at most 50,000 characters")
  return sanitizeAgreementHtml(markdown.render(expanded))
}

export function sanitizeAgreementHtml(html: string) {
  return sanitizeHtml(html, {
    allowedTags: [
      "p",
      "br",
      "hr",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "strong",
      "em",
      "s",
      "blockquote",
      "ul",
      "ol",
      "li",
      "pre",
      "code",
      "a",
      "table",
      "thead",
      "tbody",
      "tr",
      "th",
      "td",
    ],
    allowedAttributes: { a: ["href", "title"] },
    allowedSchemes: ["http", "https", "mailto"],
    allowProtocolRelative: false,
  })
}
