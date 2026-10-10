import { expect, test } from "@playwright/test"
import { loginAsAdmin, resetDatabase, seedCompletedSetup, waitForClientReady } from "./support"

test("the agreement editor follows the runtime deposit capability", async ({ page }, testInfo) => {
  await resetDatabase()
  await seedCompletedSetup()
  await loginAsAdmin(page)
  await page.goto("/agreements/new")
  await waitForClientReady(page)
  await expect(page.getByLabel("Title", { exact: true })).toBeVisible()
  const depositsEnabled = process.env.QUITS_DEPOSITS_ENABLED !== "false"
  await expect(page.getByRole("checkbox", { name: "Payment schedule line", exact: true })).toHaveCount(depositsEnabled ? 1 : 0)
  await expect(page.getByLabel("Deliverable title", { exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Add deliverable", exact: true })).toBeEnabled()
  await page.screenshot({ path: testInfo.outputPath(depositsEnabled ? "deposits-enabled.png" : "deposits-disabled.png"), fullPage: true })
})

// The browser and the POST use the real /a server functions, rather than a mocked capability.
for (const locale of ["en-US", "da-DK"]) {
  test(`historical ${locale} offers preserve terms and enforce acceptance over HTTP`, async ({ page }, testInfo) => {
    const { createTestOrganization } = await import("../../src/test-utils/organization")
    const { prisma } = await import("../../src/lib/db")
    const { executeIssuanceCommand } = await import("../../src/application/issuance")
    const { createAgreementDraft } = await import("../../src/domain/commands/agreements")
    const { issueAgreement } = await import("../../src/domain/commands/agreement-lifecycle")
    const { setRuntimeExtensions } = await import("../../src/lib/runtime/extensions")
    const { setRuntimeServices } = await import("../../src/lib/runtime/services")
    const { selfhostRuntimeServices } = await import("../../src/selfhost/runtime")
    // Store an owned synthetic artifact to verify HTTP byte preservation, without provider calls.
    setRuntimeServices({ ...selfhostRuntimeServices(), documentRenderer: {
      version: "synthetic-deposit-browser-v1",
      async renderPdf() { return new TextEncoder().encode("%PDF-1.4\nSynthetic owned agreement artifact\n%%EOF") },
    } })
    const { mintAgreementLink } = await import("../../src/lib/agreements/tokens")
    const org = await createTestOrganization({ settings: { locale, companyEmail: "seller@example.test" } })
    const depositsEnabled = process.env.QUITS_DEPOSITS_ENABLED !== "false"
    try {
      // Only fixture creation is enabled in this process. The HTTP server retains its own flag.
      setRuntimeExtensions([{ id: "historical-fixture", resolveCapabilities: () => ({ agreements: { depositsEnabled: true } }) }])
      const contact = await prisma.contact.create({ data: { organizationId: org.organizationId, name: "Synthetic customer", email: "customer@example.test" } })
      for (const deposit of [true, false]) {
        const draft = await executeIssuanceCommand(createAgreementDraft, {
          contactId: contact.id, title: "Synthetic historical offer", validUntil: "2099-01-01",
          deliverables: [{ title: "Service", quantity: "1", unitPrice: "100" }, ...(deposit ? [{ title: "Historical advance", quantity: "1", unitPrice: "20", isDeposit: true }] : [])],
        }, { actor: org.actors.admin })
        if (draft.status !== "completed") throw new Error(JSON.stringify(draft))
        const issued = await executeIssuanceCommand(issueAgreement, { id: draft.result.id }, { actor: org.actors.admin })
        if (issued.status !== "completed") throw new Error(JSON.stringify(issued))
        const token = mintAgreementLink(issued.result, "decide", new Date()).token
        const before = await prisma.agreement.findUniqueOrThrow({ where: { id: issued.result.id } })
        await page.goto(`/a/${encodeURIComponent(token)}`)
        await waitForClientReady(page)
        const pdf = await page.request.get(`/a/${encodeURIComponent(token)}/pdf`)
        expect(pdf.status()).toBe(200)
        const originalPdf = await pdf.body()
        expect(originalPdf.subarray(0, 4).toString()).toBe("%PDF")
        const canAccept = depositsEnabled || !deposit
        await expect(page.locator("#accepted-name")).toHaveCount(canAccept ? 1 : 0)
        await expect(page.locator("#decline-reason")).toBeVisible()
        await expect(page.locator('a[href$="/pdf"]')).toBeVisible()
        if (deposit) {
          await expect(page.getByRole("heading", { name: "Historical advance", exact: true })).toBeVisible()
          await page.screenshot({ path: testInfo.outputPath(`public-${locale}-${depositsEnabled ? "enabled" : "disabled"}.png`), fullPage: true })
        }
        // Import Vite's compiled client RPC and invoke its real POST transport, including Origin.
        const result = await page.evaluate(async ({ token }) => {
          const modulePath = "/src/lib/agreements/public-session.ts"
          const { submitPublicAgreementDecision } = await import(/* @vite-ignore */ modulePath)
          return submitPublicAgreementDecision({ data: { token, decision: { decision: "accept", acceptedByName: "Synthetic customer", confirmed: true } } })
        }, { token })
        const after = await prisma.agreement.findUniqueOrThrow({ where: { id: before.id } })
        if (canAccept) {
          expect(result.kind).toBe("ready")
          expect(after.status).toBe("accepted")
          expect(after.acceptedByName).toBe("Synthetic customer")
          const readPdf = await page.request.get(`/a/${encodeURIComponent(result.readLink.token)}/pdf`)
          expect(readPdf.status()).toBe(200)
          expect(await readPdf.body()).toEqual(originalPdf)
        } else {
          expect(result.kind).toBe("deposits_disabled")
          expect(after).toEqual(before)
        }
        expect(after.offerSnapshotHash).toBe(before.offerSnapshotHash)
        expect(after.offerSnapshot).toEqual(before.offerSnapshot)
      }
    } finally {
      setRuntimeExtensions([])
      await org.cleanup()
    }
  })
}

test("disabled issuance refuses a persisted deposit draft over authenticated HTTP without side effects", async ({ page }) => {
  test.skip(process.env.QUITS_DEPOSITS_ENABLED !== "false", "Requires the disabled server mode")
  await resetDatabase()
  const setup = await seedCompletedSetup()
  await loginAsAdmin(page)
  const { prisma } = await import("../../src/lib/db")
  const { resolveUserActor } = await import("../../src/domain/user-actor")
  const { executeCommand } = await import("../../src/domain/execute")
  const { createAgreementDraft } = await import("../../src/domain/commands/agreements")
  const { setRuntimeExtensions } = await import("../../src/lib/runtime/extensions")
  const member = await prisma.member.findFirstOrThrow({ where: { organizationId: setup.organizationId } })
  const actor = await resolveUserActor({ organizationId: setup.organizationId, userId: member.userId, userName: "Synthetic admin" })
  if (!actor) throw new Error("Fixture membership missing")
  try {
    setRuntimeExtensions([{ id: "draft-fixture", resolveCapabilities: () => ({ agreements: { depositsEnabled: true } }) }])
    const contact = await prisma.contact.create({ data: { organizationId: setup.organizationId, name: "Synthetic customer", email: "customer@example.test" } })
    const draft = await executeCommand(createAgreementDraft, { contactId: contact.id, title: "Synthetic deposit draft", validUntil: "2099-01-01",
      deliverables: [{ title: "Advance", quantity: "1", unitPrice: "100", isDeposit: true }],
    }, { actor })
    if (draft.status !== "completed") throw new Error(JSON.stringify(draft))
    const state = async () => {
      const where = { organizationId: setup.organizationId }
      return {
        settings: await prisma.orgSettings.findUniqueOrThrow({ where }),
        agreement: await prisma.agreement.findUniqueOrThrow({ where: { id: draft.result.id }, include: { deliverables: true } }),
        staging: await prisma.artifactStaging.findMany({ where }),
        candidates: await prisma.issuanceCandidate.findMany({ where }),
        events: await prisma.domainEvent.findMany({ where }),
        jobs: await prisma.job.findMany({ where }),
      }
    }
    const before = await state()
    for (const operation of ["issue", "send"]) {
      const response = await page.request.post(`/api/trpc/agreements.${operation}`, { data: { json: { id: draft.result.id } } })
      expect(response.status()).toBe(400)
      const error = (await response.json()).error.json
      expect(error.data.reason).toBe("deposits_disabled")
      expect(await state()).toEqual(before)
    }
  } finally { setRuntimeExtensions([]) }
})
