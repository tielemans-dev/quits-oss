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
import { issueCreditNote } from "../../../domain/commands/credit-notes"
import { creditNotePdfParties } from "../../../lib/credit-notes/pdf-parties"
import type { CreditNoteForPdf } from "../../../lib/credit-note-pdf"
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
      invoiceNextNum: momsRegistered ? 2147483646 : 1,
      cvr: "24256790", companyForm: "ApS", momsRegistered, ...(momsRegistered ? { vatId: "DK24256790" } : {}),
    }), "signup@example.test")
    await prisma.orgSettings.update({ where: { organizationId: id }, data: { locale } })
    const actor = await resolveUserActor({ organizationId: id, userId: `qui56-${id}` })
    if (!actor) throw new Error("Missing test actor")
    const contact = await executeIssuanceCommand(createContact, { name: "Test Buyer", email: "buyer@example.test", country: "DK", address: "Testvej 2", city: "København", zip: "1000", peppolEndpointScheme: "0184", peppolEndpointId: "24256790" }, { actor })
    if (contact.status !== "completed") throw new Error(JSON.stringify(contact))
    if (!momsRegistered) {
      // Self-host EU-VAT settings normalize the default to zero for a non-registered seller,
      // even when a positive rate is supplied alongside the registration choice.
      vi.stubEnv("QUITS_DISTRIBUTION", "selfhost")
      const { appRouter } = await import("../../router")
      const api = appRouter.createCaller({ session: { user: { id: `qui56-${id}`, name: "Test User", email: "signup@example.test" }, session: { activeOrganizationId: id } } } as never)
      await api.settings.update({ momsRegistered: false, taxRate: 25 })
      expect(await api.settings.get()).toMatchObject({ momsRegistered: false, taxRate: 0 })
      // An omitted line classification follows the 0% default even when the document rate is still 25%.
      const implicit = await executeIssuanceCommand(createInvoiceDraft, {
        contactId: contact.result.id, dueDate: "2026-12-01", taxRate: 25,
        items: [{ description: "Ordinary non-registered work", quantity: 1, unitPrice: 100 }],
      }, { actor })
      if (implicit.status !== "completed") throw new Error(JSON.stringify(implicit))
      const implicitDraft = await prisma.invoice.findUniqueOrThrow({ where: { id: implicit.result.id }, include: { items: true } })
      expect(parseSellerSnapshot(implicitDraft.sellerSnapshot)?.momsRegistered).toBe(false)
      expect(implicitDraft.totalTax.toNumber()).toBe(0)
      expect(implicitDraft.items[0]).toMatchObject({ vatTreatment: "unclassified_zero" })
      expect(implicitDraft.items[0]!.taxRate.toNumber()).toBe(0)
      expect(implicitDraft.items[0]!.lineTax.toNumber()).toBe(0)
      // An explicit standard classification still stores charged VAT and is refused before numbering.
      const taxed = await executeIssuanceCommand(createInvoiceDraft, {
        contactId: contact.result.id, dueDate: "2026-12-01",
        items: [{ description: "VAT-bearing work", quantity: 1, unitPrice: 100, vat: { treatment: "standard" as const, rate: "0.25", country: "DK" } }],
      }, { actor })
      if (taxed.status !== "completed") throw new Error(JSON.stringify(taxed))
      const taxedDraft = await prisma.invoice.findUniqueOrThrow({ where: { id: taxed.result.id }, include: { items: true } })
      expect(parseSellerSnapshot(taxedDraft.sellerSnapshot)?.momsRegistered).toBe(false)
      expect(taxedDraft.totalTax.toNumber()).toBe(25)
      expect(taxedDraft.items).toHaveLength(1)
      expect(taxedDraft.items[0]!.taxRate.toNumber()).toBe(25)
      expect(taxedDraft.items[0]!.lineTax.toNumber()).toBe(25)
      const rejected = await executeIssuanceCommand(sendInvoice, { id: taxed.result.id, allowSendWithoutEmail: true }, { actor })
      expect(rejected.status).not.toBe("completed")
      expect(JSON.stringify(rejected)).toContain("seller_not_vat_registered")
      expect(await prisma.invoice.findUniqueOrThrow({ where: { id: taxed.result.id } })).toMatchObject({ status: "draft", number: null, artifactPdfRef: null, artifactUblRef: null })
      expect(await prisma.artifactStaging.count({ where: { organizationId: id } })).toBe(0)
      expect(await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: id } })).toMatchObject({ invoiceNextNum: 1 })
      vi.stubEnv("QUITS_DISTRIBUTION", "cloud")
    }
    // This fixture exercises stored UBL for an explicitly classified supply. Registration alone
    // does not make an ordinary domestic sale outside scope: omitted zero-rate VAT is
    // unclassified_zero for a non-registered seller and cannot be represented in legal UBL.
    const outsideScopeVat = { treatment: "out_of_scope" as const, rate: "0" }
    const draft = await executeIssuanceCommand(createInvoiceDraft, {
      contactId: contact.result.id, dueDate: "2026-12-01", taxRate: momsRegistered ? 25 : 0,
      notes: "Original invoice note", items: [{ description: momsRegistered ? "Design" : "Explicit outside-scope supply", quantity: 1, unitPrice: 100, ...(momsRegistered ? {} : { vat: outsideScopeVat }) }],
    }, { actor })
    if (draft.status !== "completed") throw new Error(JSON.stringify(draft))
    const issued = await executeIssuanceCommand(sendInvoice, { id: draft.result.id, allowSendWithoutEmail: true }, { actor })
    if (issued.status !== "completed") throw new Error(JSON.stringify(issued))
    expect(issued).toMatchObject({ status: "completed", result: { status: "sent" } })
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: draft.result.id } })
    if (momsRegistered) {
      expect(invoice.number).toBe(`${new Intl.DateTimeFormat("en", { year: "numeric", timeZone: "Europe/Copenhagen" }).format(new Date())}-2147483646`)
      expect(await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: id } })).toMatchObject({ invoiceNextNum: 2147483647 })
      // Later assertions issue another invoice; move its fixture counter into the normal range.
      await prisma.orgSettings.update({ where: { organizationId: id }, data: { invoiceNextNum: 2 } })
    }
    expect(parseSellerSnapshot(invoice.sellerSnapshot)?.momsRegistered).toBe(momsRegistered)
    expect(invoice.artifactUblRef).toEqual(expect.any(String))
    const staging = await prisma.artifactStaging.findFirstOrThrow({ where: { organizationId: id, documentKind: "invoice", documentId: invoice.id } })
    const frozen = staging.renderInput as { pdf: { org: { cvrLabel?: string } } }
    expect(frozen.pdf.org.cvrLabel).toBe(momsRegistered ? undefined : locale === "da-DK" ? "CVR-nr." : "CVR no.")
    const originalArtifacts = { artifactUblRef: invoice.artifactUblRef, artifactUblHash: invoice.artifactUblHash, sellerSnapshot: invoice.sellerSnapshot, issuanceSnapshot: invoice.issuanceSnapshot }
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
    expect(exported.xml).toContain(`<cbc:ID>${momsRegistered ? "S" : "O"}</cbc:ID>`)
    if (!momsRegistered) {
      expect(exported.xml).toContain("Outside the scope of VAT")
      expect(exported.xml).not.toContain("<cbc:Percent>")
    }
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
      items: [{ description: momsRegistered ? "Future explicit outside-scope supply" : "Future work", quantity: 1, unitPrice: 100, ...(momsRegistered ? { vat: outsideScopeVat } : {}) }],
    }, { actor })
    if (future.status !== "completed") throw new Error(JSON.stringify(future))
    const futureIssued = await executeIssuanceCommand(sendInvoice, { id: future.result.id, allowSendWithoutEmail: true }, { actor })
    if (futureIssued.status !== "completed") throw new Error(JSON.stringify(futureIssued))
    const futureInvoice = await prisma.invoice.findUniqueOrThrow({ where: { id: future.result.id } })
    expect(parseSellerSnapshot(futureInvoice.sellerSnapshot)?.momsRegistered).toBe(!momsRegistered)
    expect(parseSellerSnapshot(futureInvoice.sellerSnapshot)?.paymentNote ?? null).toBe(momsRegistered ? "Der er ikke beregnet moms, da sælger ikke er momsregistreret." : null)
    expect(await getDocumentArtifactStore()?.get(invoice.artifactPdfRef!)).toEqual(oldPdf)
    expect(futureInvoice.artifactUblRef).toEqual(expect.any(String))
    const futureArtifacts = { artifactUblRef: futureInvoice.artifactUblRef, artifactUblHash: futureInvoice.artifactUblHash, sellerSnapshot: futureInvoice.sellerSnapshot, issuanceSnapshot: futureInvoice.issuanceSnapshot }
    const futureStoredUbl = await getDocumentArtifactStore()?.get(futureInvoice.artifactUblRef!)
    expect(futureStoredUbl).toBeInstanceOf(Uint8Array)
    const futureExport = await exportEinvoice(id, "invoice", futureInvoice.id)
    if (!futureExport.ok) throw new Error(JSON.stringify(futureExport))
    expect(futureExport.xml).toBe(new TextDecoder().decode(futureStoredUbl!))
    expect(futureExport.xml).toContain(`<cbc:ID>${momsRegistered ? "O" : "S"}</cbc:ID>`)
    const futureSupplier = futureExport.xml.split("<cac:AccountingSupplierParty>")[1]?.split("</cac:AccountingSupplierParty>")[0]
    if (momsRegistered) {
      expect(futureSupplier).not.toContain("<cac:PartyTaxScheme>")
      expect(futureExport.xml).toContain("Der er ikke beregnet moms, da sælger ikke er momsregistreret.")
    } else {
      expect(futureSupplier).toContain("<cac:PartyTaxScheme>")
      expect(futureExport.xml).not.toContain("Der er ikke beregnet moms, da sælger ikke er momsregistreret.")
    }
    const reason = "Original correction reason"
    const credited = await executeIssuanceCommand(issueCreditNote, { invoiceId: invoice.id, mode: "full", reason }, { actor })
    if (credited.status !== "completed") throw new Error(JSON.stringify(credited))
    const credit = await prisma.creditNote.findFirstOrThrow({ where: { organizationId: id, invoiceId: invoice.id } })
    expect(credit.reason).toBe(reason)
    const creditStaging = await prisma.artifactStaging.findFirstOrThrow({ where: { organizationId: id, documentKind: "creditNote", documentId: credit.id } })
    const creditInput = creditStaging.renderInput as unknown as { pdf: { creditNote: CreditNoteForPdf } }
    expect(creditInput.pdf.creditNote.reason).toBe(statement ? `${reason}\n${statement}` : reason)
    const parties = creditNotePdfParties(creditInput.pdf.creditNote, {})
    expect(parties.seller.taxIds).toContain(locale === "da-DK" ? "CVR-nr.: 24256790" : "CVR no.: 24256790")
    expect(parties.seller.taxIds.some(value => value.includes("DK24256790"))).toBe(momsRegistered)
    expect(await getDocumentArtifactStore()?.get(invoice.artifactPdfRef!)).toEqual(oldPdf)
    // Omission preserves the choice; explicit null restores unknown registration for future work.
    await api.settings.update({ taxRate: 0 })
    expect(await api.settings.get()).toMatchObject({ momsRegistered: !momsRegistered })
    await api.settings.update({ momsRegistered: null })
    expect(await api.settings.get()).toMatchObject({ momsRegistered: null })
    expect(await exportEinvoice(id, "invoice", invoice.id)).toEqual(exported)
    expect(await exportEinvoice(id, "invoice", futureInvoice.id)).toEqual(futureExport)
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).toMatchObject(originalArtifacts)
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: futureInvoice.id } })).toMatchObject(futureArtifacts)
  })
})
