import { afterEach, describe, expect, it, vi } from "vitest"
vi.mock("../../lib/email", async () => ({ ...(await vi.importActual<typeof import("../../lib/email")>("../../lib/email")), deliver: vi.fn().mockResolvedValue({ id: "synthetic-send" }) }))
import { deliver } from "../../lib/email"
import { prisma } from "../../lib/db"
import { createTestOrganization, hasTestDatabase } from "../../test-utils/organization"
import { appRouter } from "../../trpc/router"
import { setRuntimeExtensions } from "../../lib/runtime/extensions"
import { buildBuyerSnapshot, buildSellerSnapshot } from "../../domain/documents/snapshots"
import { invoiceIssueKey } from "../../lib/invoice-field-issues"
import { translate } from "../../lib/i18n/translate"
import { getDocumentArtifactStore } from "../../lib/runtime/services"
import { hashBytes } from "../../domain/documents/render-input"
import { documentPdf } from "../../lib/documents/pdf-access"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()?.(); setRuntimeExtensions([]); vi.unstubAllEnvs(); vi.mocked(deliver).mockClear() })
async function setup(bank = true) {
  vi.stubEnv("RESEND_API_KEY", "synthetic-key")
  vi.stubEnv("FROM_EMAIL", "billing@example.test")
  vi.stubEnv("BETTER_AUTH_SECRET", "synthetic-test-auth-secret-over-32-characters")
  vi.stubEnv("QUITS_PUBLIC_PAYMENT_SECRET", "synthetic-test-payment-secret")
  const org = await createTestOrganization({ settings: { countryCode: "DK", locale: "da-DK", timezone: "Europe/Copenhagen", currency: "DKK", taxRegime: "eu_vat" } })
  cleanups.push(org.cleanup)
  await prisma.orgSettings.update({ where: { organizationId: org.organizationId }, data: { companyAddress: "Testvej 1, 1000 København" } })
  await prisma.organizationTaxId.create({ data: { organizationId: org.organizationId, scheme: "cvr", value: "12345678", countryCode: "DK", isPrimary: true } })
  const caller = appRouter.createCaller({ session: { user: { id: org.actors.admin.userId, email: "admin@example.test", name: "Synthetic Admin" }, session: { activeOrganizationId: org.organizationId } } } as never)
  if (bank) await caller.paymentDetails.update({ bankAccount: { regNumber: "0040", accountNumber: "0440116243" } })
  const contact = await prisma.contact.create({ data: { organizationId: org.organizationId, name: "Synthetic Buyer", company: "Synthetic Buyer ApS", address: "Testvej 2", zip: "1000", city: "København", country: "DK", email: "buyer@example.test" } })
  const create = (pricesIncludeTax?: boolean) => caller.invoices.createV2({ contactId: contact.id, dueDate: "2099-01-01", supplyDate: "2098-12-31", taxRate: "25", pricesIncludeTax, items: [{ description: "Work", quantity: "1", unitPrice: "100", vat: { treatment: "standard", rate: "0.25", country: "DK" } }] })
  return { org, caller, contact, create }
}
;(hasTestDatabase ? describe : describe.skip)("invoice send validation and retries", () => {
  it.each(["amount", "recipient", "due date"])("rejects a changed reviewed %s without numbering or queuing", async change => {
    const { org, caller, contact, create } = await setup()
    const invoice = await create()
    const reviewed = await caller.invoices.get({ id: invoice.id })
    if (change === "amount") await prisma.invoice.update({ where: { id: invoice.id }, data: { totalGross: "250" } })
    if (change === "recipient") await prisma.contact.update({ where: { id: contact.id }, data: { email: "changed@example.test" } })
    if (change === "due date") await prisma.invoice.update({ where: { id: invoice.id }, data: { dueDate: new Date("2099-02-01") } })
    await expect(caller.invoices.send({ id: invoice.id, reviewedVersion: reviewed.reviewedVersion })).rejects.toMatchObject({
      cause: { code: "changed_since_review" },
    })
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).number).toBeNull()
    expect(await prisma.job.count({ where: { organizationId: org.organizationId, type: "email.deliver" } })).toBe(0)
  })
  it("sends an unchanged reviewed draft", async () => {
    const { caller, create } = await setup()
    const invoice = await create()
    const reviewed = await caller.invoices.get({ id: invoice.id })
    await expect(caller.invoices.send({ id: invoice.id, reviewedVersion: reviewed.reviewedVersion })).resolves.toMatchObject({ emailSent: true })
  })
  it("sends without bank details or Stripe when no adopter policy requires them, and only warns", async () => {
    const { caller, contact, create } = await setup(false)
    const readiness = await caller.invoices.sendReadiness({ contactId: contact.id })
    expect(readiness.issues.map(issue => issue.code)).not.toContain("seller.bank.required")
    expect(readiness.warnings).toEqual([{ code: "seller.bank.required", field: "seller.bankAccount", params: {} }])
    const invoice = await create()
    await expect(caller.invoices.send({ id: invoice.id })).resolves.toMatchObject({ emailSent: true })
  })
  it("blocks send before consuming a number or queuing an email without bank or Stripe when the adopter requires payment details", async () => {
    const { org, caller, create } = await setup(false)
    setRuntimeExtensions([{ id: "synthetic-policy", resolveInvoiceIssuancePolicy: () => ({ requirePaymentDetails: true }) }])
    const invoice = await create()
    await expect(caller.invoices.send({ id: invoice.id })).rejects.toMatchObject({ cause: { issues: [{ code: "seller.bank.required", field: "seller.bankAccount", params: {} }] } })
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).number).toBeNull()
    expect(await prisma.job.count({ where: { organizationId: org.organizationId, type: "email.deliver" } })).toBe(0)
  })
  it("resends legacy issued evidence after settings repair without changing frozen identities or accounts", async () => {
    const { org, caller, contact, create } = await setup(false)
    setRuntimeExtensions([{ id: "synthetic-policy", resolveInvoiceIssuancePolicy: () => ({ requirePaymentDetails: true }) }])
    const invoice = await create()
    const settings = await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: org.organizationId } })
    const ids = await prisma.organizationTaxId.findMany({ where: { organizationId: org.organizationId } })
    // MOCK: synthetic pre-gate issued invoice, with its original bankless snapshots.
    const seller = buildSellerSnapshot(settings, ids)
    const archivedBytes = new TextEncoder().encode(JSON.stringify({ number: "LEGACY-1", seller }))
    const archivedHash = hashBytes(archivedBytes)
    const archivedRef = await getDocumentArtifactStore()!.put(archivedBytes, {
      organizationId: org.organizationId, documentId: invoice.id, documentKind: "invoice", format: "pdf",
      hash: archivedHash, size: archivedBytes.length, rendererVersion: "synthetic-legacy",
    })
    const legacy = await prisma.invoice.update({ where: { id: invoice.id }, data: {
      status: "sent", number: "LEGACY-1", issueDate: new Date("2026-01-01"),
      sellerSnapshot: seller, buyerSnapshot: buildBuyerSnapshot(contact), artifactPdfRef: archivedRef, artifactPdfHash: archivedHash,
    } })
    await expect(caller.invoices.resendEmail({ id: invoice.id })).rejects.toMatchObject({ cause: { issues: [{ code: "seller.bank.required", field: "seller.bankAccount", params: {} }] } })
    expect(vi.mocked(deliver)).not.toHaveBeenCalled()
    // Without that policy the same bankless resend goes through on the frozen evidence.
    setRuntimeExtensions([])
    await caller.paymentDetails.update({ bankAccount: { regNumber: "0040", accountNumber: "0440116243" } })
    await caller.settings.update({ companyName: "Synthetic new identity" })
    await expect(caller.invoices.resendEmail({ id: invoice.id })).resolves.toMatchObject({ emailSent: true })
    const resent = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })
    for (const field of ["sellerSnapshot", "buyerSnapshot", "issuanceSnapshot", "artifactPdfRef", "artifactPdfHash", "artifactUblRef", "artifactUblHash", "number", "issueDate"] as const) expect(resent[field]).toEqual(legacy[field])
    expect(vi.mocked(deliver)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(deliver).mock.calls[0]![0].html).not.toContain("Synthetic new identity")
    expect(JSON.stringify(vi.mocked(deliver).mock.calls)).not.toContain("0440116243")
    const archived = await documentPdf("invoice", invoice.id, org.organizationId)
    expect(archived.headers.get("X-Quits-Artifact")).toBe("stored")
    expect(new Uint8Array(await archived.arrayBuffer())).toEqual(archivedBytes)
  })
  it.each([null, "", "not-an-email", " buyer@example.test "])("checks recipient %s before confirmation without persisting a draft", async email => {
    const { org, caller, contact } = await setup()
    await prisma.contact.update({ where: { id: contact.id }, data: { email } })
    const readiness = await caller.invoices.sendReadiness({ contactId: contact.id })
    expect(readiness.issues.filter(issue => issue.field === "customer.email")).toEqual(email?.trim() === "buyer@example.test" ? [] : [{ code: "missing_recipient", field: "customer.email", params: {} }])
    expect(await prisma.invoice.count({ where: { organizationId: org.organizationId } })).toBe(0)
    expect(await prisma.job.count({ where: { organizationId: org.organizationId, type: "email.deliver" } })).toBe(0)
    for (const locale of ["da-DK", "en-US"]) expect(translate(invoiceIssueKey("missing_recipient"), locale)).not.toBe("invoiceValidation.unknown")
  })
  it("allows Stripe without a bank account", async () => {
    const { caller, create } = await setup(false)
    await caller.settings.update({ stripePublishableKey: "pk_test_synthetic", stripeSecretKey: "sk_test_synthetic_123456789", stripeWebhookSecret: "whsec_synthetic_123456789" })
    const invoice = await create()
    await expect(caller.invoices.send({ id: invoice.id })).resolves.toMatchObject({ emailSent: true })
  })
  it("concurrent clicks and a later retry produce one email and one issuance", async () => {
    const { org, caller, create } = await setup()
    const invoice = await create()
    const results = await Promise.allSettled([caller.invoices.send({ id: invoice.id }), caller.invoices.send({ id: invoice.id })])
    expect(results.some(result => result.status === "fulfilled")).toBe(true)
    // A call that lands after delivery settled is refused like any send of an issued invoice.
    for (const result of results) if (result.status === "rejected") expect(result.reason).toMatchObject({ cause: { code: "not_draft" } })
    await expect(caller.invoices.send({ id: invoice.id })).rejects.toMatchObject({ cause: { code: "not_draft" } })
    expect(vi.mocked(deliver)).toHaveBeenCalledTimes(1)
    expect(await prisma.job.count({ where: { organizationId: org.organizationId, type: "email.deliver" } })).toBe(1)
    expect(await prisma.domainEvent.count({ where: { aggregateId: invoice.id, type: "invoice.issued" } })).toBe(1)
    expect(await prisma.domainEvent.count({ where: { aggregateId: invoice.id, type: "invoice.sent" } })).toBe(1)
  })
  it("collects both org gaps and structured customer issues", async () => {
    const { org, caller, contact, create } = await setup(false)
    await prisma.organizationTaxId.deleteMany({ where: { organizationId: org.organizationId } })
    await prisma.contact.update({ where: { id: contact.id }, data: { company: "", country: "SE" } })
    setRuntimeExtensions([{ id: "synthetic-policy", resolveInvoiceIssuancePolicy: () => ({ requirePaymentDetails: true, requireCvr: true, requireBusinessBuyer: true, buyerCountries: ["DK"], standardVatRate: "25", sellerVatRegistered: false }) }])
    const readiness = await caller.invoices.sendReadiness({ contactId: contact.id })
    expect(readiness.standardVatRate).toBe("25")
    expect(readiness.issues.map(issue => issue.code)).toEqual(expect.arrayContaining(["cvr.invalid", "seller.vatRegistration.required", "seller.bank.required", "customer.businessName.required", "customer.country.unsupported"]))
    const invoice = await create()
    await expect(caller.invoices.send({ id: invoice.id })).rejects.toMatchObject({ cause: { issues: expect.arrayContaining(readiness.issues) } })
  })
  it("keeps readiness and draft creation available when the issuance policy cannot be resolved, and refuses the send", async () => {
    const { caller, contact, create } = await setup()
    setRuntimeExtensions([{ id: "synthetic-policy", resolveInvoiceIssuancePolicy: () => { throw new Error("synthetic outage") } }])
    const readiness = await caller.invoices.sendReadiness({ contactId: contact.id })
    expect(readiness).toMatchObject({ policyUnavailable: true, businessBuyersOnly: false, standardVatRate: null })
    const invoice = await create()
    await expect(caller.invoices.send({ id: invoice.id })).rejects.toMatchObject({ cause: { code: "issuance_policy_unavailable" } })
  })
  it("reports an unsupported invoice currency for the chosen currency before any draft exists", async () => {
    const { org, caller } = await setup()
    setRuntimeExtensions([{ id: "synthetic-policy", resolveInvoiceIssuancePolicy: () => ({ currencies: ["DKK"] }) }])
    expect((await caller.invoices.sendReadiness({ currency: "DKK" })).issues).toEqual([])
    expect((await caller.invoices.sendReadiness({ currency: "USD" })).issues).toEqual([
      { code: "currency.unsupported", field: "currency", params: { currencies: "DKK" } },
    ])
    expect(await prisma.invoice.count({ where: { organizationId: org.organizationId } })).toBe(0)
  })
  it("reports business-only customers solely when an adopter policy requires them", async () => {
    const { caller } = await setup()
    expect((await caller.invoices.sendReadiness()).businessBuyersOnly).toBe(false)
    setRuntimeExtensions([{ id: "synthetic-policy", resolveInvoiceIssuancePolicy: () => ({ requireBusinessBuyer: true }) }])
    expect((await caller.invoices.sendReadiness()).businessBuyersOnly).toBe(true)
  })
  it("snapshots the draft price basis and recalculates when the toggle changes", async () => {
    const { org, caller, create } = await setup()
    const invoice = await create(false)
    expect(invoice.pricesIncludeTax).toBe(false)
    expect(invoice.total).toBe(125)
    await prisma.orgSettings.update({ where: { organizationId: org.organizationId }, data: { pricesIncludeTax: true } })
    const same = await caller.invoices.updateV2({ id: invoice.id, notes: "Keep basis" })
    expect(same.pricesIncludeTax).toBe(false)
    const toggled = await caller.invoices.updateV2({ id: invoice.id, pricesIncludeTax: true })
    expect(toggled.total).toBe(100)
    expect(toggled.pricesIncludeTax).toBe(true)
    expect((await create()).pricesIncludeTax).toBe(true)
  })
})
