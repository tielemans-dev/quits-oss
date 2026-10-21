import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
vi.mock("../../email", async () => ({
  ...await vi.importActual<typeof import("../../email")>("../../email"), deliver: vi.fn(),
}))
import { prisma } from "../../db"
import { deliver, type EmailMessage } from "../../email"
import { createTestOrganization, hasTestDatabase } from "../../../test-utils/organization"
import { setRuntimeServices, resetRuntimeServices, type RenderInput } from "../../runtime/services"
import { executeIssuanceCommand, issueDocument } from "../../../application/issuance"
import { createInvoiceDraft, resendInvoiceEmail } from "../../../domain/commands/invoices"
import { sendCreditNote } from "../../../domain/commands/credit-notes"
import { hashBytes } from "../../../domain/documents/hash"

const cleanups: Array<() => Promise<void>> = []
const bytes = new Map<string, Uint8Array>()
const render = vi.fn(async (input: RenderInput) => new TextEncoder().encode(JSON.stringify(input)))
beforeEach(() => {
  vi.stubEnv("RESEND_API_KEY", "synthetic-attachment")
  vi.stubEnv("FROM_EMAIL", "billing@example.test")
  vi.stubEnv("BETTER_AUTH_SECRET", "synthetic-attachment-secret-over-thirty-two-characters")
  vi.mocked(deliver).mockReset().mockResolvedValue({ id: "synthetic-delivery" })
  bytes.clear()
  setRuntimeServices({ documentRenderer: { version: "test-v1", renderPdf: render }, documentArtifactStore: {
    async put(value, meta) { const ref = `${meta.organizationId}/${meta.documentId}/${meta.hash}.pdf`; bytes.set(ref, value); return ref },
    async get(ref) { return bytes.get(ref) ?? null }, async head() { return null }, async delete(ref) { bytes.delete(ref) },
  } })
})
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.()
  resetRuntimeServices(); vi.unstubAllEnvs()
})

async function issuedInvoice() {
  const org = await createTestOrganization()
  cleanups.push(org.cleanup)
  const contact = await prisma.contact.create({ data: { organizationId: org.organizationId, name: "Customer", email: "customer@example.test" } })
  const draft = await executeIssuanceCommand(createInvoiceDraft, { contactId: contact.id, dueDate: "2099-01-01", taxRate: 0,
    items: [{ description: "Work", quantity: 1, unitPrice: 100 }] }, { actor: org.actors.admin })
  if (draft.status !== "completed") throw new Error(JSON.stringify(draft))
  const sent = await issueDocument({ kind: "invoice", commandInput: { id: draft.result.id }, actor: org.actors.admin, clientRequestId: "send" })
  expect(sent, JSON.stringify(sent)).toMatchObject({ status: "completed" })
  return { org, invoice: await prisma.invoice.findUniqueOrThrow({ where: { id: draft.result.id } }) }
}
const lastMessage = () => vi.mocked(deliver).mock.calls.at(-1)![0] as EmailMessage & { attachments?: Array<{ filename: string; content: string }> }
const attachedBytes = (message: ReturnType<typeof lastMessage>) => new Uint8Array(Buffer.from(message.attachments![0]!.content, "base64"))
const attachedLine = /attached as a PDF|vedhæftet som PDF/

;(hasTestDatabase ? describe : describe.skip)("document emails attach the issued PDF", () => {
  it("attaches the stored, hash-checked bytes to the invoice and credit-note emails", async () => {
    const { org, invoice } = await issuedInvoice()
    const invoiceEmail = lastMessage()
    expect(invoiceEmail.attachments).toHaveLength(1)
    expect(invoiceEmail.attachments![0]).toMatchObject({ filename: `${invoice.number}.pdf`, contentType: "application/pdf" })
    expect(attachedBytes(invoiceEmail)).toEqual(bytes.get(invoice.artifactPdfRef!))
    expect(hashBytes(attachedBytes(invoiceEmail))).toBe(invoice.artifactPdfHash)
    expect(invoiceEmail.html).toMatch(attachedLine)

    const credit = await issueDocument({ kind: "creditNote", commandInput: { invoiceId: invoice.id, mode: "full", reason: "Correction" },
      actor: org.actors.admin, clientRequestId: "credit" })
    expect(credit, JSON.stringify(credit)).toMatchObject({ status: "completed" })
    const creditNote = await prisma.creditNote.findFirstOrThrow({ where: { invoiceId: invoice.id } })
    expect(await executeIssuanceCommand(sendCreditNote, { id: creditNote.id }, { actor: org.actors.admin })).toMatchObject({ status: "completed" })
    const creditEmail = lastMessage()
    expect(creditEmail.attachments![0]).toMatchObject({ filename: `${creditNote.number}.pdf`, contentType: "application/pdf" })
    expect(attachedBytes(creditEmail)).toEqual(bytes.get(creditNote.artifactPdfRef!))
    expect(hashBytes(attachedBytes(creditEmail))).toBe(creditNote.artifactPdfHash)
    expect(creditEmail.html).toContain(creditNote.number)
    expect(creditEmail.html).toMatch(attachedLine)
  })

  it("sends without an attachment, never a fresh render, when the stored PDF is altered or missing", async () => {
    const { org, invoice } = await issuedInvoice()
    render.mockClear()
    bytes.set(invoice.artifactPdfRef!, new TextEncoder().encode("altered"))
    expect(await executeIssuanceCommand(resendInvoiceEmail, { id: invoice.id }, { actor: org.actors.admin })).toMatchObject({ status: "completed" })
    expect(lastMessage().attachments).toBeUndefined()
    expect(lastMessage().html).not.toMatch(attachedLine)

    bytes.delete(invoice.artifactPdfRef!)
    expect(await executeIssuanceCommand(resendInvoiceEmail, { id: invoice.id }, { actor: org.actors.admin })).toMatchObject({ status: "completed" })
    expect(vi.mocked(deliver)).toHaveBeenCalledTimes(3)
    expect(lastMessage().attachments).toBeUndefined()
    expect(render).not.toHaveBeenCalled()
  })
})
