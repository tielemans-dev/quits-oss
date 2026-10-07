/**
 * A tiny XML writer for generated documents. Builds an element tree and serializes it with
 * escaping, so callers never concatenate markup by hand.
 */

export type XmlElement = {
  name: string
  attributes: Record<string, string>
  children: XmlElement[]
  text: string | null
}

type XmlChild = XmlElement | null | undefined | false | readonly XmlChild[]

/** Drops characters XML 1.0 cannot represent at all, even escaped. */
export function stripInvalidXmlChars(value: string): string {
  let result = ""
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    const allowedControl = code === 0x9 || code === 0xa || code === 0xd
    if ((code < 0x20 && !allowedControl) || code === 0xfffe || code === 0xffff) continue
    result += char
  }
  return result
}

export function escapeXmlText(value: string): string {
  return stripInvalidXmlChars(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

export function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value)
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(/\t/g, "&#9;")
    .replace(/\n/g, "&#10;")
    .replace(/\r/g, "&#13;")
}

function flatten(children: readonly XmlChild[]): XmlElement[] {
  const result: XmlElement[] = []
  for (const child of children) {
    if (!child) continue
    if (Array.isArray(child)) {
      result.push(...flatten(child))
    } else {
      result.push(child as XmlElement)
    }
  }
  return result
}

/** An element with child elements. Falsy children are skipped, arrays are flattened. */
export function element(
  name: string,
  attributes: Record<string, string | null | undefined> | null,
  ...children: XmlChild[]
): XmlElement {
  return { name, attributes: cleanAttributes(attributes), children: flatten(children), text: null }
}

/** An element holding text. Returns null when the value is empty so optional fields drop out. */
export function textElement(
  name: string,
  value: string | number | null | undefined,
  attributes?: Record<string, string | null | undefined>
): XmlElement | null {
  if (value === null || value === undefined) return null
  const text = String(value).trim()
  if (text.length === 0) return null
  return { name, attributes: cleanAttributes(attributes ?? null), children: [], text }
}

function cleanAttributes(attributes: Record<string, string | null | undefined> | null) {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(attributes ?? {})) {
    if (value !== null && value !== undefined) result[key] = value
  }
  return result
}

function serializeElement(node: XmlElement, depth: number, lines: string[]) {
  const indent = "  ".repeat(depth)
  const attributes = Object.entries(node.attributes)
    .map(([key, value]) => ` ${key}="${escapeXmlAttribute(value)}"`)
    .join("")

  if (node.text !== null) {
    lines.push(`${indent}<${node.name}${attributes}>${escapeXmlText(node.text)}</${node.name}>`)
    return
  }
  if (node.children.length === 0) {
    lines.push(`${indent}<${node.name}${attributes}/>`)
    return
  }
  lines.push(`${indent}<${node.name}${attributes}>`)
  for (const child of node.children) serializeElement(child, depth + 1, lines)
  lines.push(`${indent}</${node.name}>`)
}

export function serializeXmlDocument(root: XmlElement): string {
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>']
  serializeElement(root, 0, lines)
  return `${lines.join("\n")}\n`
}
