import { captureInvoiceEmail, captureOnboarding, capturePdf } from "./seller-vat-evidence"
import { expect, test } from "@playwright/test"
import { bootstrapQuitsRuntime } from "../../src/lib/runtime/bootstrap"
import { prisma } from "../../src/lib/db"
import { signInvoicePaymentToken } from "../../src/lib/payments/public"
import { danishLocale, loginAsAdmin, resetDatabase, seedCompletedSetup, waitForClientReady } from "./support"

// MOCK: synthetic baseline fixture only. Main has no non-registration choice; this is visual evidence, not feature verification.
for (const locale of ["da-DK", "en-US"]) {
  test(`captures main before non-registration UI in ${locale}`, async ({ page }) => {
    bootstrapQuitsRuntime({})
    await resetDatabase()
    const setup = await seedCompletedSetup({ ...danishLocale, locale })
    await prisma.orgSettings.update({ where: { organizationId: setup.organizationId }, data: {
      companyName: "Synthetic Seller", companyAddress: "Testvej 1, 1000 København", taxRate: 25,
      bankRegNumber: "0040", bankAccountNumber: "0440116243",
    } })
    const contact = await prisma.contact.create({ data: { organizationId: setup.organizationId, name: "Synthetic Buyer", email: "buyer@example.test", country: "DK" } })
    const invoice = await prisma.invoice.create({ data: {
      organizationId: setup.organizationId, contactId: contact.id, number: "INV-0001", status: "sent",
      issueDate: new Date("2026-10-11"), dueDate: new Date("2026-11-09"),
      subtotalNet: "1000", totalTax: "0", totalGross: "1000", currency: "DKK", countryCode: "DK", locale,
      timezone: "Europe/Copenhagen", taxRegime: "eu_vat", pricesIncludeTax: false,
      publicPaymentIssuedAt: new Date(), publicPaymentKeyVersion: 1,
      sellerSnapshot: { companyName: "Synthetic Seller", companyAddress: "Testvej 1, 1000 København" },
      items: { create: [{ description: "Synthetic consulting", quantity: "2", unitPriceNet: "500", unitPriceGross: "500", lineNet: "1000", lineTax: "0", lineGross: "1000", taxRate: "0", taxCategory: "standard", sortOrder: 0 }] },
    } })
    const token = signInvoicePaymentToken({ invoiceId: invoice.id, keyVersion: 1, scope: "invoice_payment" }, "qui62-browser-payment-test-secret")
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
