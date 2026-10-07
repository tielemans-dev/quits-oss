import MarkdownIt from "markdown-it"
import sanitizeHtml from "sanitize-html"

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

export function renderAgreementMarkdown(source: string, placeholders: Record<string, string> = {}) {
  if (source.length > 50_000) throw new Error("Agreement terms must be at most 50,000 characters")
  const expanded = source.replace(/\{\{([a-zA-Z.]+)\}\}/g, (token, key: string) =>
    Object.hasOwn(placeholders, key) ? escapeAgreementPlaceholder(placeholders[key]!) : token,
  )
  if (expanded.length > 50_000)
    throw new Error("Expanded agreement terms must be at most 50,000 characters")
  return sanitizeHtml(markdown.render(expanded), {
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
