import { afterEach, describe, expect, it, vi } from "vitest"
vi.mock("../../auth", () => ({ auth: { api: { getSession: vi.fn() } } }))
vi.mock("../../agreement-pdf", () => ({
  agreementPdfResponse: vi.fn(async (input) => Response.json(input)),
}))
import { auth } from "../../auth"
import { prisma } from "../../db"
import { createTestOrganization, hasTestDatabase } from "../../../test-utils/organization"
import { executeCommand } from "../../../domain/execute"
import { createAgreementDraft, updateAgreementDraft } from "../../../domain/commands/agreements"
import { issueAgreement } from "../../../domain/commands/agreement-lifecycle"
import { createAgentKey, authenticateAgentSecret } from "../../../domain/agent-keys"
import { approvalAgreementPdf, privateAgreementPdf, publicAgreementPdf } from "../pdf-access"
import { mintAgreementLink } from "../tokens"
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.()
  vi.unstubAllEnvs()
  vi.mocked(auth.api.getSession).mockReset()
})
;(hasTestDatabase ? describe : describe.skip)(
  "agreement PDF authorization and preview binding",
  () => {
    it("renders the stored A snapshot while the live draft is B, with organization and session checks", async () => {
      vi.stubEnv("BETTER_AUTH_SECRET", "preview-test-only-secret-over-32-characters")
      const org = await createTestOrganization()
      cleanups.push(org.cleanup)
      const contact = await prisma.contact.create({
        data: { organizationId: org.organizationId, name: "Customer" },
      })
      const draft = await executeCommand(
        createAgreementDraft,
        {
          contactId: contact.id,
          title: "Preview A",
          validUntil: "2099-01-01",
          termsMarkdown: "Terms A",
          deliverables: [{ title: "Work", quantity: 1, unitPrice: 100 }],
        },
        { actor: org.actors.admin },
      )
      if (draft.status !== "completed") throw new Error("draft failed")
      const actor = await authenticateAgentSecret(
        (
          await createAgentKey(org.actors.admin, {
            name: "Preview",
            mode: "approval_required",
            scopes: ["agreement:send"],
          })
        ).secret,
      )
      const queued = await executeCommand(
        issueAgreement,
        { id: draft.result.id },
        { actor, clientRequestId: "preview" },
      )
      if (queued.status !== "awaiting_approval") throw new Error("approval failed")
      const request = new Request("http://quits.test/preview")
      vi.mocked(auth.api.getSession).mockResolvedValue(null)
      expect((await approvalAgreementPdf(request, queued.approvalRequestId)).status).toBe(401)
      vi.mocked(auth.api.getSession).mockResolvedValue({
        user: { id: org.actors.admin.userId },
        session: { activeOrganizationId: org.organizationId },
      } as never)
      await executeCommand(
        updateAgreementDraft,
        { id: draft.result.id, title: "Preview B", termsMarkdown: "Terms B" },
        { actor: org.actors.admin },
      )
      const preview = await approvalAgreementPdf(request, queued.approvalRequestId)
      expect(preview.status).toBe(200)
      expect(await preview.json()).toMatchObject({
        snapshot: { title: "Preview A", termsHtml: "<p>Terms A</p>\n" },
      })
      expect((await privateAgreementPdf(request, draft.result.id)).status).toBe(404)
      const issued = await executeCommand(
        issueAgreement,
        { id: draft.result.id },
        { actor: org.actors.admin },
      )
      if (issued.status !== "completed") throw new Error("issue failed")
      expect(await (await privateAgreementPdf(request, draft.result.id)).json()).toMatchObject({
        snapshot: { title: "Preview B" },
      })
      expect(
        (await publicAgreementPdf(mintAgreementLink(issued.result, "decide", new Date()).token))
          .status,
      ).toBe(200)
      expect((await publicAgreementPdf("invalid")).status).toBe(404)
      const other = await createTestOrganization()
      cleanups.push(other.cleanup)
      vi.mocked(auth.api.getSession).mockResolvedValue({
        user: { id: other.actors.admin.userId },
        session: { activeOrganizationId: other.organizationId },
      } as never)
      expect((await approvalAgreementPdf(request, queued.approvalRequestId)).status).toBe(404)
      expect((await privateAgreementPdf(request, draft.result.id)).status).toBe(404)
      vi.mocked(auth.api.getSession).mockResolvedValue(null)
      expect((await privateAgreementPdf(request, draft.result.id)).status).toBe(401)
    })
  },
)
