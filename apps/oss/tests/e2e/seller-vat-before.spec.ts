import { captureInvoiceEmail, captureOnboarding, capturePdf } from "./seller-vat-evidence"
import { expect, test } from "@playwright/test"
import { selfhostRuntimeServices } from "../../src/selfhost/runtime"
import { executeCommand } from "../../src/domain/execute"
import { issueDocument } from "../../src/application/issuance"
import { createInvoiceDraft } from "../../src/domain/commands/invoices"
import { resolveUserActor } from "../../src/domain/user-actor"
import { bootstrapQuitsRuntime } from "../../src/lib/runtime/bootstrap"
import { prisma } from "../../src/lib/db"
import { signInvoicePaymentToken } from "../../src/lib/payments/public"
import { danishLocale, loginAsAdmin, resetDatabase, seedCompletedSetup, waitForClientReady } from "./support"

// MOCK: synthetic baseline fixture only. Main has no non-registration choice; this is visual evidence, not feature verification.
for (const locale of ["da-DK", "en-US"]) {
  test(`captures main before non-registration UI in ${locale}`, async ({ page }) => {
    bootstrapQuitsRuntime({ services: selfhostRuntimeServices() })
    await resetDatabase()
    const setup = await seedCompletedSetup({ ...danishLocale, locale })
    await prisma.orgSettings.update({ where: { organizationId: setup.organizationId }, data: {
      companyName: "Synthetic Seller", companyAddress: "Testvej 1, 1000 København", taxRate: 25,
      // Danish EU VAT issuance refuses an unset seller status. Record a VAT-registered seller
      // so this out-of-scope zero-VAT baseline can still be issued.
      momsRegistered: true,
      bankRegNumber: "0040", bankAccountNumber: "0440116243",
    } })
    // MOCK: main's Danish compliance profile requires a seller tax identifier even for zero-VAT issuance.
    await prisma.organizationTaxId.create({ data: { organizationId: setup.organizationId, scheme: "cvr", value: "12345678", countryCode: "DK" } })
    const contact = await prisma.contact.create({ data: { organizationId: setup.organizationId, name: "Synthetic Buyer", email: "buyer@example.test", country: "DK" } })
    const member = await prisma.member.findFirstOrThrow({ where: { organizationId: setup.organizationId, role: "admin" } })
    const actor = await resolveUserActor({ organizationId: setup.organizationId, userId: member.userId })
    if (!actor) throw new Error("Synthetic admin is missing")
    // MOCK: out-of-scope zero VAT is the pre-non-registration baseline. The seller status above is explicit.
    // Use production issuance to freeze and store the real PDF instead of seeding a sent row without an artifact.
    const draft = await executeCommand(createInvoiceDraft, { contactId: contact.id,
      dueDate: "2026-11-09", supplyDate: "2026-10-11", taxRate: 0,
      items: [{ description: "Synthetic consulting", quantity: 2, unitPrice: 500, vat: { treatment: "out_of_scope", rate: "0" } }] }, { actor })
    if (draft.status !== "completed") throw new Error(JSON.stringify(draft))
    const issued = await issueDocument({ kind: "invoice", actor,
      commandInput: { id: draft.result.id, allowSendWithoutEmail: true } })
    if (issued.status !== "completed") throw new Error(JSON.stringify(issued))
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: draft.result.id } })
    expect(invoice.status).toBe("sent")
    expect(invoice.artifactPdfRef).toBeTruthy()
    const token = signInvoicePaymentToken({ invoiceId: invoice.id, keyVersion: invoice.publicPaymentKeyVersion, scope: "invoice_payment" }, "qui62-browser-payment-test-secret")
    await loginAsAdmin(page)
    for (const [surface, path] of [["settings", "/settings"], ["invoice", `/invoices/${invoice.id}`], ["pay", `/pay/${encodeURIComponent(token)}`]]) {
      await page.goto(path!)
      await waitForClientReady(page)
      for (const colorScheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme })
        await page.evaluate(() => localStorage.setItem("quits-theme", "system"))
        await page.reload()
        await waitForClientReady(page)
        if (surface !== "pay") await expect(page.locator("html")).toHaveClass(colorScheme === "dark" ? /dark/ : /^(?!.*\bdark\b)/)
        for (const [device, width] of [["desktop", 1440], ["mobile390", 390]] as const) {
          await page.setViewportSize({ width, height: 1100 })
          await page.screenshot({ path: test.info().outputPath(`${surface}-${locale}-${colorScheme}-${device}-before.png`), fullPage: true })
        }
      }
    }
    await captureInvoiceEmail(page, invoice.id, setup.organizationId, locale, `http://127.0.0.1:3040/pay/${encodeURIComponent(token)}`)
    await capturePdf(page, "invoice", invoice.id, locale)
    await captureOnboarding(page, setup.organizationId, locale)
  })
}
