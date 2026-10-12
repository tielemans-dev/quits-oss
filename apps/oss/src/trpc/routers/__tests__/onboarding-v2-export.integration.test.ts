import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { confirmOnboardingV2Schema } from "@quits/contracts/onboarding"
import { parseSellerSnapshot } from "@quits/contracts/documents"
import { executeIssuanceCommand } from "../../../application/issuance"
import { createContact } from "../../../domain/commands/contacts"
import { createInvoiceDraft, sendInvoice } from "../../../domain/commands/invoices"
import { resolveUserActor } from "../../../domain/user-actor"
import { prisma } from "../../../lib/db"
import { selfhostDocumentRenderer, localDiskArtifactStore } from "../../../selfhost/runtime"
import { exportEinvoice } from "../../../lib/exports/einvoice"
import { confirmOnboardingV2 } from "../../../lib/onboarding/confirm-v2"
import { cleanupTestOrganizations, hasTestDatabase } from "../../../test-utils/organization"
import { ensureTestMembership } from "../../../test-utils/membership"
import { bootstrapQuitsRuntime } from "../../../lib/runtime/bootstrap"
import { getDocumentArtifactStore, setRuntimeServices } from "../../../lib/runtime/services"

const ids: string[] = []
let artifactDirectory: string
;(hasTestDatabase ? describe : describe.skip)("onboarding v2 issued UBL", () => {
  beforeEach(async () => {
    bootstrapQuitsRuntime({})
    vi.stubEnv("QUITS_DISTRIBUTION", "cloud")
    artifactDirectory = await mkdtemp(join(tmpdir(), "qui56-ubl-"))
    setRuntimeServices({
      documentRenderer: selfhostDocumentRenderer,
      documentArtifactStore: localDiskArtifactStore(artifactDirectory),
    })
  })
  afterEach(async () => {
    vi.unstubAllEnvs()
    for (const id of ids.splice(0)) await cleanupTestOrganizations({ where: { id } })
    await rm(artifactDirectory, { recursive: true, force: true })
  })
  it.each([
    [false, "da-DK", "Virksomheden er ikke momsregistreret."],
    [false, "en-US", "The company is not VAT registered."],
    [true, "en-US", null],
  ] as const)("freezes registration %s and the %s statement from confirmation through issuance", async (momsRegistered, locale, statement) => {
    const id = randomUUID()
    ids.push(id)
    await prisma.organization.create({ data: { id, name: "Before confirm", slug: `qui56-export-${id}`, createdAt: new Date() } })
    await ensureTestMembership(id, `qui56-${id}`)
    await confirmOnboardingV2(id, confirmOnboardingV2Schema.parse({
      idempotencyKey: randomUUID(), companyName: "Synthetic Test ApS", companyAddress: "Testvej 1\n1000 København",
      cvr: "24256790", companyForm: "ApS", momsRegistered, ...(momsRegistered ? { vatId: "DK24256790" } : {}),
    }), "signup@example.test")
    await prisma.orgSettings.update({ where: { organizationId: id }, data: { locale } })
    const actor = await resolveUserActor({ organizationId: id, userId: `qui56-${id}` })
    if (!actor) throw new Error("Missing test actor")
    const contact = await executeIssuanceCommand(createContact, { name: "Test Buyer", email: "buyer@example.test", country: "DK", address: "Testvej 2", city: "København", zip: "1000", peppolEndpointScheme: "0184", peppolEndpointId: "24256790" }, { actor })
    if (contact.status !== "completed") throw new Error(JSON.stringify(contact))
    const draft = await executeIssuanceCommand(createInvoiceDraft, {
      contactId: contact.result.id, dueDate: "2026-12-01", taxRate: momsRegistered ? 25 : 0,
      notes: "Original invoice note", items: [{ description: "Design", quantity: 1, unitPrice: 100 }],
    }, { actor })
    if (draft.status !== "completed") throw new Error(JSON.stringify(draft))
    const issued = await executeIssuanceCommand(sendInvoice, { id: draft.result.id, allowSendWithoutEmail: true }, { actor })
    if (issued.status !== "completed") throw new Error(JSON.stringify(issued))
    expect(issued).toMatchObject({ status: "completed", result: { status: "sent" } })
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: draft.result.id } })
    expect(parseSellerSnapshot(invoice.sellerSnapshot)?.momsRegistered).toBe(momsRegistered)
    expect(invoice.artifactUblRef).toEqual(expect.any(String))
    const storedUbl = await getDocumentArtifactStore()?.get(invoice.artifactUblRef!)
    expect(storedUbl).toBeInstanceOf(Uint8Array)
    const exported = await exportEinvoice(id, "invoice", invoice.id)
    if (!exported.ok) throw new Error(JSON.stringify(exported))
    expect(exported.xml).toBe(new TextDecoder().decode(storedUbl!))
    const supplier = exported.xml.split("<cac:AccountingSupplierParty>")[1]?.split("</cac:AccountingSupplierParty>")[0]
    expect(supplier).toBeDefined()
    expect(supplier).toContain("24256790")
    if (momsRegistered) expect(supplier).toContain("DK24256790")
    else expect(supplier).not.toContain("<cac:PartyTaxScheme>")
    expect(exported.xml).toContain("Original invoice note")
    if (statement) {
      expect(exported.xml).toContain(statement)
      const pdf = await getDocumentArtifactStore()?.get(invoice.artifactPdfRef!)
      expect(new TextDecoder().decode(pdf!.slice(0, 5))).toBe("%PDF-")
      if (locale === "en-US") expect(exported.xml).not.toContain("Virksomheden er ikke momsregistreret.")
    } else expect(exported.xml).not.toContain("The company is not VAT registered.")
    // Current settings cannot change an issued invoice's registration or language.
    await prisma.orgSettings.update({ where: { organizationId: id }, data: { momsRegistered: !momsRegistered, locale: "da-DK", paymentNote: "Changed note" } })
    expect(await exportEinvoice(id, "invoice", invoice.id)).toEqual(exported)
  })
})
