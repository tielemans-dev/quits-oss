import { mkdir } from "node:fs/promises"
import { expect, test } from "@playwright/test"
import { prisma } from "../../src/lib/db"
import { createInvoiceDraft } from "../../src/domain/commands/invoices"
import { executeCommand } from "../../src/domain/execute"
import { resolveUserActor } from "../../src/domain/user-actor"
import { bootstrapQuitsRuntime } from "../../src/lib/runtime/bootstrap"
import { signInvoicePaymentToken } from "../../src/lib/payments/public"
import { translate } from "../../src/lib/i18n/translate"
import { danishLocale, loginAsAdmin, resetDatabase, seedCompletedSetup, waitForClientReady } from "./support"

// Synthetic organizations and invoices only; the config refuses any other database.
const evidence = "../../docs/evidence/qui62"
for (const locale of ["da-DK", "en-US"]) {
  test(`saves the explicit ${locale} choice and issues without VAT`, async ({ page }) => {
    await mkdir(evidence, { recursive: true })
    await resetDatabase()
    const setup = await seedCompletedSetup({ ...danishLocale, locale })
    await prisma.orgSettings.update({ where: { organizationId: setup.organizationId }, data: {
      companyName: "Synthetic Seller", companyAddress: "Testvej 1, 1000 København", taxRate: 25,
      bankRegNumber: "0040", bankAccountNumber: "0440116243",
    } })
    await prisma.organizationTaxId.create({ data: { organizationId: setup.organizationId, scheme: "cvr", value: "12345678", countryCode: "DK" } })
    await loginAsAdmin(page)
    await page.goto("/settings")
    await waitForClientReady(page)
    const yes = page.getByRole("radio", { name: translate("vatStatus.yes", locale), exact: true })
    const no = page.getByRole("radio", { name: translate("vatStatus.no", locale), exact: true })
    await expect(yes).not.toBeChecked()
    await expect(no).not.toBeChecked()
    await page.screenshot({ path: `${evidence}/settings-${locale}-desktop-unset-after.png`, fullPage: true })
    await no.check()
    await page.getByRole("button", { name: translate("settings.action.save", locale), exact: true }).click()
    await expect(page.getByText(translate("settings.success.saved", locale), { exact: true })).toBeVisible()
    await page.reload()
    await expect(no).toBeChecked()
    for (const [device, width] of [["desktop", 1440], ["mobile", 390]] as const) {
      await page.setViewportSize({ width, height: 1100 })
      await page.screenshot({ path: `${evidence}/settings-${locale}-${device}-after.png`, fullPage: true })
    }
    const member = await prisma.member.findFirstOrThrow({ where: { organizationId: setup.organizationId, role: "admin" } })
    const actor = await resolveUserActor({ organizationId: setup.organizationId, userId: member.userId })
    if (!actor) throw new Error("Synthetic admin is missing")
    bootstrapQuitsRuntime({})
    const contact = await prisma.contact.create({ data: { organizationId: setup.organizationId, name: "Synthetic Buyer", email: "buyer@example.test", address: "Testvej 2", city: "København", zip: "1000", country: "DK" } })
    const draft = await executeCommand(createInvoiceDraft, { contactId: contact.id, dueDate: "2026-11-09", supplyDate: "2026-10-11", taxRate: 0,
      items: [{ description: "Synthetic consulting", quantity: 2, unitPrice: 500, vat: { treatment: "unclassified_zero", rate: "0" } }] }, { actor })
    if (draft.status !== "completed") throw new Error(JSON.stringify(draft))
    await page.goto(`/invoices/${draft.result.id}`)
    await waitForClientReady(page)
    await expect(page.getByText(translate("line.noVat", locale), { exact: true })).toBeVisible()
    await page.getByRole("button", { name: translate("invoices.detail.email.degraded.trigger", locale), exact: true }).click()
    await page.getByRole("button", { name: translate("invoices.detail.email.degraded.confirm", locale), exact: true }).click()
    await expect.poll(async () => (await prisma.invoice.findUniqueOrThrow({ where: { id: draft.result.id } })).status).toBe("sent")
    for (const [device, width] of [["desktop", 1440], ["mobile", 390]] as const) {
      await page.setViewportSize({ width, height: 1100 })
      await page.screenshot({ path: `${evidence}/invoice-${locale}-${device}-after.png`, fullPage: true })
    }
    const row = await prisma.invoice.findUniqueOrThrow({ where: { id: draft.result.id } })
    const token = signInvoicePaymentToken({ invoiceId: row.id, keyVersion: row.publicPaymentKeyVersion, scope: "invoice_payment" }, "qui62-browser-payment-test-secret")
    await page.goto(`/pay/${encodeURIComponent(token)}`)
    await expect(page.getByText(translate("pdf.nonVatRegistered", locale), { exact: true })).toBeVisible()
    for (const [device, width] of [["desktop", 1440], ["mobile", 390]] as const) {
      await page.setViewportSize({ width, height: 1100 })
      await page.screenshot({ path: `${evidence}/pay-${locale}-${device}-after.png`, fullPage: true })
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    }
  })
}
