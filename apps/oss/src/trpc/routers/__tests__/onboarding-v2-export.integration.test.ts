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
import { setRuntimeExtensions } from "../../../lib/runtime/extensions"
import { bootstrapQuitsRuntime } from "../../../lib/runtime/bootstrap"
import { getDocumentArtifactStore, setRuntimeServices } from "../../../lib/runtime/services"

const ids: string[] = []
let artifactDirectory: string
;(hasTestDatabase ? describe : describe.skip)("onboarding v2 issued UBL", () => {
  beforeEach(async () => {
    bootstrapQuitsRuntime({})
    setRuntimeExtensions([{ id: "non-vat-test", resolveCapabilities: () => ({ onboardingV2: { enabled: true, nonVatEnabled: true } }) }])
    vi.stubEnv("QUITS_DISTRIBUTION", "cloud")
    artifactDirectory = await mkdtemp(join(tmpdir(), "qui56-ubl-"))
    setRuntimeServices({
      documentRenderer: selfhostDocumentRenderer,
      documentArtifactStore: localDiskArtifactStore(artifactDirectory),
    })
  })
  afterEach(async () => {
    vi.unstubAllEnvs()
    setRuntimeExtensions([])
    for (const id of ids.splice(0)) await cleanupTestOrganizations({ where: { id } })
    await rm(artifactDirectory, { recursive: true, force: true })
  })
  it.each([
    [false, "da-DK", "Der er ikke beregnet moms, da sælger ikke er momsregistreret."],
    [false, "en-US", "No VAT charged – the seller is not VAT-registered."],
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
    const staging = await prisma.artifactStaging.findFirstOrThrow({ where: { organizationId: id, documentKind: "invoice", documentId: invoice.id } })
    const frozen = staging.renderInput as { pdf: { org: { cvrLabel?: string } } }
    expect(frozen.pdf.org.cvrLabel).toBe(momsRegistered ? undefined : locale === "da-DK" ? "CVR-nr." : "CVR no.")
    const storedUbl = await getDocumentArtifactStore()?.get(invoice.artifactUblRef!)
    expect(storedUbl).toBeInstanceOf(Uint8Array)
    const oldPdf = await getDocumentArtifactStore()?.get(invoice.artifactPdfRef!)
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
      if (locale === "en-US") expect(exported.xml).not.toContain("Der er ikke beregnet moms, da sælger ikke er momsregistreret.")
    } else expect(exported.xml).not.toContain("No VAT charged – the seller is not VAT-registered.")
    // Current settings cannot change an issued invoice's registration or language.
    vi.resetModules()
    const { appRouter } = await import("../../router")
    const runtime = await import("../../../lib/runtime/extensions")
    runtime.setRuntimeExtensions([{ id: "non-vat-test", resolveCapabilities: () => ({ onboardingV2: { enabled: true, nonVatEnabled: true } }) }])
    const api = appRouter.createCaller({ session: { user: { id: `qui56-${id}`, name: "Test User", email: "signup@example.test" }, session: { activeOrganizationId: id } } } as never)
    expect(await api.settings.get()).toMatchObject({ momsRegistered })
    await api.settings.update({ momsRegistered: !momsRegistered, locale: "da-DK" })
    expect(await api.settings.get()).toMatchObject({ momsRegistered: !momsRegistered })
    expect(await exportEinvoice(id, "invoice", invoice.id)).toEqual(exported)
    const future = await executeIssuanceCommand(createInvoiceDraft, {
      contactId: contact.result.id, dueDate: "2026-12-01", taxRate: momsRegistered ? 0 : 25,
      items: [{ description: "Future work", quantity: 1, unitPrice: 100 }],
    }, { actor })
    if (future.status !== "completed") throw new Error(JSON.stringify(future))
    const futureIssued = await executeIssuanceCommand(sendInvoice, { id: future.result.id, allowSendWithoutEmail: true }, { actor })
    if (futureIssued.status !== "completed") throw new Error(JSON.stringify(futureIssued))
    const futureInvoice = await prisma.invoice.findUniqueOrThrow({ where: { id: future.result.id } })
    expect(parseSellerSnapshot(futureInvoice.sellerSnapshot)?.momsRegistered).toBe(!momsRegistered)
    expect(parseSellerSnapshot(futureInvoice.sellerSnapshot)?.paymentNote ?? null).toBe(momsRegistered ? "Der er ikke beregnet moms, da sælger ikke er momsregistreret." : null)
    expect(await getDocumentArtifactStore()?.get(invoice.artifactPdfRef!)).toEqual(oldPdf)
    const futureExport = await exportEinvoice(id, "invoice", futureInvoice.id)
    if (!futureExport.ok) throw new Error(JSON.stringify(futureExport))
    const futureSupplier = futureExport.xml.split("<cac:AccountingSupplierParty>")[1]?.split("</cac:AccountingSupplierParty>")[0]
    if (momsRegistered) {
      expect(futureSupplier).not.toContain("<cac:PartyTaxScheme>")
      expect(futureExport.xml).toContain("Der er ikke beregnet moms, da sælger ikke er momsregistreret.")
    } else {
      expect(futureSupplier).toContain("<cac:PartyTaxScheme>")
      expect(futureExport.xml).not.toContain("Der er ikke beregnet moms, da sælger ikke er momsregistreret.")
    }
    // Omission preserves the choice; explicit null restores unknown registration for future work.
    await api.settings.update({ taxRate: 0 })
    expect(await api.settings.get()).toMatchObject({ momsRegistered: !momsRegistered })
    await api.settings.update({ momsRegistered: null })
    expect(await api.settings.get()).toMatchObject({ momsRegistered: null })
    expect(await exportEinvoice(id, "invoice", invoice.id)).toEqual(exported)
    expect(await exportEinvoice(id, "invoice", futureInvoice.id)).toEqual(futureExport)
  })
})
