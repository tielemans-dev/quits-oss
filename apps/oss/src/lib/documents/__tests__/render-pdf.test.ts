import { beforeEach, describe, expect, it, vi } from "vitest"
import { renderPdf } from "../render-pdf"
import type { DocumentRenderer, RenderInput } from "../../runtime/services"

const { errorLog } = vi.hoisted(() => ({ errorLog: vi.fn() }))
vi.mock("../../observability", () => ({ appLogger: { child: () => ({ error: errorLog }) } }))

describe("PDF failure reporting", () => {
  beforeEach(() => vi.clearAllMocks())

  it.each(["invoice", "creditNote", "agreement", "quote"])("reports %s failures without document contents and rethrows", async kind => {
    const input = { kind, organizationId: "org-1", documentId: "doc-1", recipient: "private@example.test", pdf: { private: "contents" } } as unknown as RenderInput
    const failure = new Error("private renderer response")
    const renderer: DocumentRenderer = { version: "test-v1", renderPdf: vi.fn().mockRejectedValue(failure) }
    await expect(renderPdf(renderer, input)).rejects.toBe(failure)
    expect(errorLog).toHaveBeenCalledExactlyOnceWith("document.pdf_render_failed", {
      organizationId: "org-1", documentId: "doc-1", documentKind: kind,
      rendererVersion: "test-v1", errorType: "Error",
    })
  })

  it("returns successful bytes without an alert", async () => {
    const bytes = new Uint8Array([1, 2, 3])
    const renderer: DocumentRenderer = { version: "test-v1", renderPdf: vi.fn().mockResolvedValue(bytes) }
    expect(await renderPdf(renderer, {} as RenderInput)).toBe(bytes)
    expect(errorLog).not.toHaveBeenCalled()
  })
})
