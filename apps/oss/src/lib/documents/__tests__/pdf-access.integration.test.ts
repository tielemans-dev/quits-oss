import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
vi.mock("../../auth", () => ({ auth: { api: { getSession: vi.fn() } } }))
import { auth } from "../../auth"
import { prisma } from "../../db"
import { createTestOrganization, hasTestDatabase } from "../../../test-utils/organization"
import { setRuntimeServices, resetRuntimeServices, type RenderInput } from "../../runtime/services"
import { privateDocumentPdf, publicInvoicePdf } from "../pdf-access"
import { issueDocument } from "../../../application/issuance"
import { signInvoicePaymentToken } from "../../payments/public"

const cleanups: Array<() => Promise<void>> = []
const bytes = new Map<string, Uint8Array>()
const render = vi.fn(async (input: RenderInput) => new TextEncoder().encode(JSON.stringify(input)))
const get = vi.fn(async (ref: string) => bytes.get(ref) ?? null)
beforeEach(() => {
  bytes.clear(); render.mockClear(); get.mockClear()
  vi.stubEnv("RESEND_API_KEY", "")
  vi.stubEnv("QUITS_PUBLIC_PAYMENT_SECRET", "synthetic-download-link-secret")
  setRuntimeServices({ documentRenderer: { version: "test-v1", renderPdf: render }, documentArtifactStore: {
    async put(value, meta) { const ref = `${meta.organizationId}/${meta.documentId}/${meta.hash}.pdf`; bytes.set(ref, value); return ref },
    get, async head() { return null }, async delete(ref) { bytes.delete(ref) },
  } })
})
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.()
  resetRuntimeServices(); vi.unstubAllEnvs(); vi.mocked(auth.api.getSession).mockReset()
})
async function setup() {
  const org = await createTestOrganization()
  cleanups.push(org.cleanup)
  const contact = await prisma.contact.create({ data: { organizationId: org.organizationId, name: "Owner customer", email: "customer@example.test" } })
  const invoice = await prisma.invoice.create({ data: {
    organizationId: org.organizationId, contactId: contact.id, number: "INV-0001", dueDate: new Date("2099-01-01"),
    subtotalNet: 100, totalGross: 100, items: { create: { description: "Work", quantity: 1, unitPriceNet: 100,
      // Direct Prisma fixtures must classify zero-rate lines explicitly; standard requires a positive rate.
      unitPriceGross: 100, lineNet: 100, lineGross: 100, lineTax: 0, taxRate: 0,
      taxCategory: "O", vatTreatment: "out_of_scope", sortOrder: 0 } },
  } })
  vi.mocked(auth.api.getSession).mockResolvedValue({ user: { id: org.actors.admin.userId }, session: { activeOrganizationId: org.organizationId } } as never)
  return { org, invoice }
}
const request = new Request("http://quits.test/download")
;(hasTestDatabase ? describe : describe.skip)("authorized archived PDF downloads", () => {
  it("refuses unauthenticated and other-organization requests before accessing bytes", async () => {
    const { invoice } = await setup()
    vi.mocked(auth.api.getSession).mockResolvedValue(null)
    expect((await privateDocumentPdf(request, "invoice", invoice.id)).status).toBe(401)
    const other = await createTestOrganization(); cleanups.push(other.cleanup)
    vi.mocked(auth.api.getSession).mockResolvedValue({ user: { id: other.actors.admin.userId }, session: { activeOrganizationId: other.organizationId } } as never)
    expect((await privateDocumentPdf(request, "invoice", invoice.id)).status).toBe(404)
    expect(get).not.toHaveBeenCalled(); expect(render).not.toHaveBeenCalled()
  })
  it("renders drafts live and labels pre-change issued documents reconstructed", async () => {
    const { invoice } = await setup()
    const draft = await privateDocumentPdf(request, "invoice", invoice.id)
    expect(draft.headers.get("X-Quits-Artifact")).toBe("live")
    expect(await draft.json()).toMatchObject({ pdf: { invoice: { status: "draft" } } })
    await prisma.invoice.update({ where: { id: invoice.id }, data: { status: "sent" } })
    const legacy = await privateDocumentPdf(request, "invoice", invoice.id)
    expect(legacy.headers.get("X-Quits-Artifact")).toBe("reconstructed")
    expect(render).toHaveBeenCalledTimes(2)
  })
  it("serves issued bytes unchanged and reports an unavailable archived object without rendering over it", async () => {
    const { org, invoice } = await setup()
    const sent = await issueDocument({ kind: "invoice", actor: org.actors.admin,
      commandInput: { id: invoice.id, allowSendWithoutEmail: true }, clientRequestId: "archive" })
    expect(sent, JSON.stringify(sent)).toMatchObject({ status: "completed" })
    const archived = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })
    render.mockClear()
    await prisma.contact.update({ where: { id: invoice.contactId }, data: { name: "Changed later" } })
    const response = await privateDocumentPdf(request, "invoice", invoice.id)
    expect(response.headers.get("X-Quits-Artifact")).toBe("stored")
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes.get(archived.artifactPdfRef!))
    bytes.delete(archived.artifactPdfRef!)
    expect((await privateDocumentPdf(request, "invoice", invoice.id)).status).toBe(503)
    expect(render).not.toHaveBeenCalled()
  })
  it("uses the existing public invoice signature and refuses invalid or revoked links", async () => {
    const { org, invoice } = await setup()
    const sent = await issueDocument({ kind: "invoice", actor: org.actors.admin, commandInput: { id: invoice.id, allowSendWithoutEmail: true }, clientRequestId: "public" })
    expect(sent, JSON.stringify(sent)).toMatchObject({ status: "completed" })
    await prisma.invoice.update({ where: { id: invoice.id }, data: { publicPaymentIssuedAt: new Date() } })
    const token = signInvoicePaymentToken({ invoiceId: invoice.id, keyVersion: invoice.publicPaymentKeyVersion, scope: "invoice_payment" }, "synthetic-download-link-secret")
    expect((await publicInvoicePdf(token)).headers.get("X-Quits-Artifact")).toBe("stored")
    expect((await publicInvoicePdf("invalid")).status).toBe(404)
    await prisma.invoice.update({ where: { id: invoice.id }, data: { publicPaymentKeyVersion: { increment: 1 } } })
    expect((await publicInvoicePdf(token)).status).toBe(404)
  })
})
