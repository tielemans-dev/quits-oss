import { createAgreementDraft } from "../../src/domain/commands/agreements"
import { mintAgreementLink } from "../../src/lib/agreements/tokens"
import { captureDocument, captureInvoiceEmail, captureOnboarding, capturePdf } from "./seller-vat-evidence"
import { buildCreditNoteEmailContent } from "../../src/lib/emails/credit-note-email"
import { issueDocument } from "../../src/application/issuance"
import { expect, test, type Page } from "@playwright/test"
import { prisma } from "../../src/lib/db"
import { createInvoiceDraft } from "../../src/domain/commands/invoices"
import { executeCommand } from "../../src/domain/execute"
import { resolveUserActor } from "../../src/domain/user-actor"
import { selfhostRuntimeServices } from "../../src/selfhost/runtime"
import { bootstrapQuitsRuntime } from "../../src/lib/runtime/bootstrap"
import { signInvoicePaymentToken } from "../../src/lib/payments/public"
import { translate } from "../../src/lib/i18n/translate"
import { isPublicDocumentPath } from "../../src/lib/theme"
import { danishLocale, loginAsAdmin, resetDatabase, seedCompletedSetup, waitForClientReady } from "./support"

// MOCK: synthetic organizations and invoices only; the config refuses any other database.
async function capture(page: Page, surface: string, locale: string) {
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme })
    await page.evaluate(() => localStorage.setItem("quits-theme", "system"))
    await page.reload()
    await waitForClientReady(page)
    // Recipient invoices, quotes and agreements stay light under either browser preference.
    const publicDocument = isPublicDocumentPath(new URL(page.url()).pathname)
    const expectedDark = !publicDocument && colorScheme === "dark"
    await expect(page.locator("html")).toHaveClass(expectedDark ? /\bdark\b/ : /^(?!.*\bdark\b)/)
    await expect(page.locator("html[data-document]")).toHaveCount(publicDocument ? 1 : 0)
    for (const [device, width] of [["desktop", 1440], ["mobile390", 390]] as const) {
      await page.setViewportSize({ width, height: 1100 })
      await page.screenshot({ path: test.info().outputPath(`${surface}-${locale}-${colorScheme}-${device}-after.png`), fullPage: true })
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    }
  }
}
for (const locale of ["da-DK", "en-US"]) {
  test(`saves the explicit ${locale} choice and issues without VAT`, async ({ page }) => {
    await resetDatabase()
    const setup = await seedCompletedSetup({ ...danishLocale, locale })
    await prisma.orgSettings.update({ where: { organizationId: setup.organizationId }, data: {
      companyName: "Synthetic Seller", companyAddress: "Testvej 1, 1000 København", taxRate: 25,
      paymentNote: translate("pdf.nonVatRegistered", locale),
      bankRegNumber: "0040", bankAccountNumber: "0440116243",
    } })
    await prisma.organizationTaxId.create({ data: { organizationId: setup.organizationId, scheme: "cvr", value: "12345678", countryCode: "DK" } })
    await loginAsAdmin(page)
    await page.goto("/settings")
    await waitForClientReady(page)
    for (const [countryCode, taxRegime] of [["US", "us_sales_tax"], ["DE", "eu_vat"], ["DK", "custom"]] as const) {
      await prisma.orgSettings.update({ where: { organizationId: setup.organizationId }, data: { countryCode, taxRegime } })
      await page.reload()
      await waitForClientReady(page)
      await expect(page.getByRole("radio", { name: translate("vatStatus.no", locale), exact: true })).toHaveCount(0)
      await expect(page.getByText(translate("vatStatus.noHint", locale), { exact: true })).toHaveCount(0)
    }
    await prisma.orgSettings.update({ where: { organizationId: setup.organizationId }, data: { countryCode: "DK", taxRegime: "eu_vat" } })
    await page.reload()
    await waitForClientReady(page)
    const yes = page.getByRole("radio", { name: translate("vatStatus.yes", locale), exact: true })
    const no = page.getByRole("radio", { name: translate("vatStatus.no", locale), exact: true })
    await expect(yes).not.toBeChecked()
    await expect(no).not.toBeChecked()
    await capture(page, "settings-unset", locale)
    await no.check()
    await page.getByRole("button", { name: translate("settings.action.save", locale), exact: true }).click()
    await expect(page.getByText(translate("settings.success.saved", locale), { exact: true })).toBeVisible()
    await expect(page.locator("#taxRate")).toHaveValue("0")
    await page.reload()
    await expect(no).toBeChecked()
    await capture(page, "settings", locale)
    const member = await prisma.member.findFirstOrThrow({ where: { organizationId: setup.organizationId, role: "admin" } })
    const actor = await resolveUserActor({ organizationId: setup.organizationId, userId: member.userId })
    if (!actor) throw new Error("Synthetic admin is missing")
    bootstrapQuitsRuntime({ services: selfhostRuntimeServices() })
    const contact = await prisma.contact.create({ data: { organizationId: setup.organizationId, name: "Synthetic Buyer", email: "buyer@example.test", address: "Testvej 2", city: "København", zip: "1000", country: "DK" } })
    // MOCK: VAT classification rates are fractions; the document taxRate is a percentage.
    const contradictory = await executeCommand(createInvoiceDraft, { contactId: contact.id, dueDate: "2026-11-09", taxRate: 25,
      items: [{ description: "Synthetic existing VAT draft", quantity: 1, unitPrice: 100, vat: { treatment: "standard", rate: "0.25" } }] }, { actor })
    if (contradictory.status !== "completed") throw new Error(JSON.stringify(contradictory))
    await page.goto(`/invoices/${contradictory.result.id}`)
    await waitForClientReady(page)
    await expect(page.getByText("25 % moms", { exact: true })).toBeVisible()
    await expect(page.getByText(translate("line.noVat", locale), { exact: true })).toHaveCount(0)
    await capture(page, "invoice-existing-vat-draft", locale)
    const draft = await executeCommand(createInvoiceDraft, { contactId: contact.id, notes: translate("pdf.nonVatRegistered", locale), dueDate: "2026-11-09", supplyDate: "2026-10-11", taxRate: 0,
      items: [{ description: "Synthetic consulting", quantity: 2, unitPrice: 500, vat: { treatment: "unclassified_zero", rate: "0" } }] }, { actor })
    if (draft.status !== "completed") throw new Error(JSON.stringify(draft))
    await page.goto(`/invoices/${draft.result.id}`)
    await waitForClientReady(page)
    await expect(page.getByText(translate("line.noVat", locale), { exact: true })).toBeVisible()
    await page.getByRole("button", { name: translate("invoices.detail.email.degraded.trigger", locale), exact: true }).click()
    await page.getByRole("button", { name: translate("invoices.detail.email.degraded.confirm", locale), exact: true }).click()
    await expect.poll(async () => (await prisma.invoice.findUniqueOrThrow({ where: { id: draft.result.id } })).status).toBe("sent")
    await expect(page.getByText(translate("pdf.nonVatRegistered", locale), { exact: true })).toHaveCount(1)
    await capture(page, "invoice", locale)
    const row = await prisma.invoice.findUniqueOrThrow({ where: { id: draft.result.id } })
    const token = signInvoicePaymentToken({ invoiceId: row.id, keyVersion: row.publicPaymentKeyVersion, scope: "invoice_payment" }, "qui62-browser-payment-test-secret")
    await page.goto(`/pay/${encodeURIComponent(token)}`)
    await expect(page.getByText(translate("pdf.nonVatRegistered", locale), { exact: true })).toBeVisible()
    await expect(page.getByText(translate("pdf.nonVatRegistered", locale), { exact: true })).toHaveCount(1)
    await capture(page, "pay", locale)
    await captureInvoiceEmail(page, row.id, setup.organizationId, locale, `http://127.0.0.1:3040/pay/${encodeURIComponent(token)}`)
    await capturePdf(page, "invoice", row.id, locale)
    const agreementDraft = await executeCommand(createAgreementDraft, { contactId: contact.id, title: "Synthetic non-VAT agreement", validUntil: "2099-12-01", taxRate: 0,
      deliverables: [{ title: "Synthetic service", description: "Service", quantity: 1, unitPrice: 100, vat: { treatment: "unclassified_zero", rate: "0" } }],
    }, { actor })
    if (agreementDraft.status !== "completed") throw new Error(JSON.stringify(agreementDraft))
    const agreementIssue = await issueDocument({ kind: "agreement", actor, commandInput: { id: agreementDraft.result.id }, options: { method: "manual" } })
    if (agreementIssue.status !== "completed") throw new Error(JSON.stringify(agreementIssue))
    const agreement = await prisma.agreement.findUniqueOrThrow({ where: { id: agreementDraft.result.id } })
    // Customer-facing agreement status stays frozen after the seller's current choice changes.
    await prisma.orgSettings.update({ where: { organizationId: setup.organizationId }, data: { momsRegistered: true } })
    const agreementLink = mintAgreementLink(agreement, "decide", new Date())
    await page.goto(`/a/${encodeURIComponent(agreementLink.token)}`)
    await expect(page.getByText(translate("pdf.nonVatRegistered", locale), { exact: true })).toHaveCount(1)
    await expect(page.getByText(translate("line.noVat", locale), { exact: true })).toBeVisible()
    await capture(page, "agreement-public", locale)
    // Freeze the credit choice from the invoice, even after current settings change.
    await prisma.orgSettings.update({ where: { organizationId: setup.organizationId }, data: { momsRegistered: true } })
    const outcome = await issueDocument({ kind: "creditNote", actor, commandInput: { invoiceId: row.id, mode: "full", reason: translate("pdf.nonVatRegistered", locale) } })
    if (outcome.status !== "completed") throw new Error(JSON.stringify(outcome))
    const credit = await prisma.creditNote.findFirstOrThrow({ where: { invoiceId: row.id }, include: { items: true } })
    await page.goto(`/credit-notes/${credit.id}`)
    await waitForClientReady(page)
    await expect(page.getByText(translate("pdf.nonVatRegistered", locale), { exact: true })).toHaveCount(1)
    await capture(page, "credit-note", locale)
    await capturePdf(page, "creditNote", credit.id, locale)
    const creditEmail = buildCreditNoteEmailContent({ creditNote: { number: credit.number, issueDate: credit.issueDate,
      sellerSnapshot: credit.sellerSnapshot, reason: credit.reason, subtotal: credit.subtotalNet.toNumber(), taxAmount: credit.totalTax.toNumber(), total: credit.totalGross.toNumber(), currency: credit.currency,
      priceBasis: "net", items: credit.items.map(item => ({ description: item.description, quantity: item.quantity.toNumber(), unitPrice: item.unitPriceNet.toNumber(), total: item.lineNet.toNumber(), taxRate: item.taxRate.toNumber() })) },
      invoice: { number: row.number!, issueDate: row.issueDate }, org: { locale }, contactName: "Synthetic Buyer" }).html
    expect(creditEmail.split(translate("pdf.nonVatRegistered", locale))).toHaveLength(2)
    await captureDocument(page, "credit-note-email", locale, creditEmail)
    await captureOnboarding(page, setup.organizationId, locale)
  })
}
