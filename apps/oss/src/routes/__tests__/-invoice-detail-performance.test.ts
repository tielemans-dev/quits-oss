import { afterEach, describe, expect, it, vi } from "vitest"

afterEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
})

describe("invoice detail route performance", () => {
  it("does not import the PDF helper during initial route module load", async () => {
    let invoicePdfModuleLoads = 0

    vi.doMock("../../lib/invoice-pdf", () => {
      invoicePdfModuleLoads += 1
      return {
        downloadInvoicePdf: vi.fn(),
      }
    })

    await import("../_app/invoices/$invoiceId")

    expect(invoicePdfModuleLoads).toBe(0)
  })
})
