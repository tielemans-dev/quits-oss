import { isValidElement, type ReactElement, type ReactNode } from "react"
import { inflateSync } from "node:zlib"
import { describe, expect, it } from "vitest"
import { Svg, Text, renderToBuffer } from "@react-pdf/renderer"
import { InvoicePdfDocument, type InvoiceForPdf } from "../invoice-pdf"
import { DraftWatermark, draftWatermarkGlyphs } from "../documents/draft-watermark"
import { messageCatalog } from "../i18n/catalog"

const invoice: InvoiceForPdf = {
  number: "INV-0042",
  status: "sent",
  issueDate: "2026-10-01T00:00:00.000Z",
  dueDate: "2026-10-31T00:00:00.000Z",
  subtotal: 1000,
  taxAmount: 250,
  total: 1250,
  currency: "DKK",
  notes: null,
  contact: { name: "Kunde A/S" },
  items: [{ description: "Design", quantity: 1, unitPrice: 1250, total: 1250 }],
}
const draft = { ...invoice, number: "", status: "draft" }
const quote = { expiryDate: "2026-10-31T00:00:00.000Z" }
const documentFor = (input: InvoiceForPdf, locale: string, asQuote = false) =>
  InvoicePdfDocument({ invoice: input, org: { locale }, quote: asQuote ? quote : undefined })

/** Every element of a react-pdf tree in document order, with function components expanded. */
function elementsOf(node: ReactNode): ReactElement<{ children?: ReactNode; fixed?: boolean }>[] {
  if (Array.isArray(node)) return node.flatMap(elementsOf)
  if (!isValidElement<{ children?: ReactNode; fixed?: boolean }>(node)) return []
  if (typeof node.type === "function") return [node, ...elementsOf((node.type as (props: unknown) => ReactNode)(node.props))]
  return [node, ...elementsOf(node.props.children)]
}
/** The text of a react-pdf element tree, one entry per `Text` element, in document order. */
function textOf(node: ReactNode): string[] {
  const inner = (child: ReactNode): string => Array.isArray(child) ? child.map(inner).join("")
    : typeof child === "string" || typeof child === "number" ? String(child)
    : isValidElement<{ children?: ReactNode }>(child) ? inner(child.props.children) : ""
  return elementsOf(node).filter(element => element.type === Text).map(element => inner(element.props.children))
}
const watermarksOf = (node: ReactNode) =>
  elementsOf(node).filter(element => element.type === DraftWatermark).map(element => (element.props as { word: string }).word)

/**
 * The text a PDF reader extracts: every text-showing operator in the page content streams, one
 * entry per text object. react-pdf writes the standard fonts in WinAnsi as hex strings.
 */
function extractedText(pdf: Buffer): string[] {
  const winAnsi = new TextDecoder("windows-1252")
  const streams = [...pdf.toString("latin1").matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)]
    .map(([, body]) => { try { return inflateSync(Buffer.from(body, "latin1")).toString("latin1") } catch { return "" } })
  return streams.flatMap(stream => [...stream.matchAll(/BT([\s\S]*?)ET/g)].map(([, block]) =>
    [...block.matchAll(/<([0-9a-f]*)>/gi)].map(([, hex]) => winAnsi.decode(Buffer.from(hex, "hex"))).join("")))
}

describe("draft PDF marking", () => {
  it.each([
    ["da-DK", false, "KLADDE", ["Kladde – ikke en gyldig faktura", "Fakturakladde "]],
    ["en-US", false, "DRAFT", ["Draft – not a valid invoice", "Draft invoice "]],
    ["da-DK", true, "KLADDE", ["Kladde – ikke et gyldigt tilbud", "Tilbudskladde "]],
    ["en-US", true, "DRAFT", ["Draft – not a valid quote", "Draft quote "]],
  ] as const)("marks a %s draft (quote: %s) as not valid", (locale, asQuote, watermark, marking) => {
    const tree = documentFor(draft, locale, asQuote)
    expect(textOf(tree)).toEqual(expect.arrayContaining([...marking]))
    expect(watermarksOf(tree)).toEqual([watermark])
  })

  it.each([["da-DK", false], ["en-US", false], ["da-DK", true], ["en-US", true]] as const)(
    "leaves an issued %s document (quote: %s) unmarked",
    (locale, asQuote) => {
      const tree = documentFor(invoice, locale, asQuote)
      expect(textOf(tree).join("\n")).not.toMatch(/kladde|draft|ikke en gyldig|ikke et gyldigt|not a valid/i)
      expect(watermarksOf(tree)).toEqual([])
    },
  )

  it("repeats the marking on every page", () => {
    const fixed = elementsOf(documentFor(draft, "da-DK")).filter(element => element.props.fixed)
    expect(fixed.flatMap(textOf)).toContain("Kladde – ikke en gyldig faktura")
    expect(fixed.some(element => elementsOf(element.props.children).some(child => child.type === Svg))).toBe(true)
  })

  it.each(Object.entries(messageCatalog))("draws every letter of the %s watermark", (_, catalog) => {
    for (const letter of catalog["pdf.draft.watermark"]) expect(draftWatermarkGlyphs).toHaveProperty(letter)
  })

  // The watermark crosses the content diagonally. As text, extractors spliced its letters into the
  // lines it crossed, so copy-paste, screen readers and text search read a draft wrongly.
  it.each([["da-DK", "KLADDE", "Subtotal ekskl. moms"], ["en-US", "DRAFT", "Subtotal excl. tax"]] as const)(
    "keeps the watermark out of the extracted text of a %s draft",
    async (locale, watermark, subtotal) => {
      const items = [{ description: "Synthetic reverse charge domestic evidence", quantity: 1, unitPrice: 1250, total: 1250 }]
      const text = extractedText(await renderToBuffer(documentFor({ ...draft, items }, locale)))
      expect(text).toEqual(expect.arrayContaining(["Synthetic reverse charge domestic evidence", subtotal]))
      expect(text.join("\n")).not.toContain(watermark)
      expect(text.filter(run => watermark.includes(run.trim()) && run.trim())).toEqual([])
    },
  )
})
