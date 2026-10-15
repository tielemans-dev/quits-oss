import { expect, test } from "@playwright/test"
import { prisma } from "../../src/lib/db"
import { translate } from "../../src/lib/i18n/translate"
import { adminCredentials, appOrigin, danishLocale, resetDatabase, seedPublicInvoice, usEnglishLocale, waitForClientReady } from "./support"

// Real app and authentication in disposable CI PostgreSQL; only the rejected save is synthetic.
for (const locale of [danishLocale, usEnglishLocale]) {
  test(`QUI-39 customer and invoice edit errors in ${locale.locale}`, async ({ page }) => {
    await resetDatabase()
    const seeded = await seedPublicInvoice({ locale })
    const invoice = await prisma.invoice.update({ where: { id: seeded.id }, data: { status: "draft", number: null } })
    const t = (key: Parameters<typeof translate>[0]) => translate(key, locale.locale)
    const origin = new URL(appOrigin).origin
    expect((await page.request.post("/api/auth/sign-in/email", { data: adminCredentials, headers: { origin } })).ok()).toBe(true)
    expect((await page.request.post("/api/auth/organization/set-active", { data: { organizationId: invoice.organizationId }, headers: { origin } })).ok()).toBe(true)
    await page.goto("/invoices/new")
    await waitForClientReady(page)
    await page.getByRole("button", { name: t("docForm.action.saveDraft"), exact: true }).click()
    await expect(page.getByText(t("invoiceValidation.customer.required"), { exact: true })).toBeVisible()
    await page.locator("#invoice-contact").click()
    await page.getByRole("option", { name: "Invoice Customer", exact: true }).click()
    await expect(page.getByText(t("invoiceValidation.customer.required"), { exact: true })).toHaveCount(0)
    await expect(page.locator("#invoice-contact")).not.toHaveAttribute("aria-invalid", "true")

    await page.goto(`/invoices/${seeded.id}`)
    await waitForClientReady(page)
    await page.getByRole("button", { name: t("invoices.detail.action.edit"), exact: true }).click()
    const raw = JSON.stringify([{ code: "too_small", path: ["items", 0, "description"], message: "Raw schema failure" }])
    await page.route("**/api/trpc/invoices.updateV2*", route => route.fulfill({ status: 400, json: [{ error: { json: {
      message: raw, code: -32600, data: { code: "BAD_REQUEST", httpStatus: 400, path: "invoices.updateV2" },
    } } }] }))
    await page.getByRole("button", { name: t("docForm.action.saveChanges"), exact: true }).click()
    await expect(page.getByText(t("validation.line.description.required"), { exact: true })).toBeVisible()
    await expect(page.locator("body")).not.toContainText('"path"')
    await expect(page.locator("body")).not.toContainText("Raw schema failure")
    const description = page.getByRole("textbox", { name: t("docForm.column.description"), exact: true })
    await expect(description).toHaveAttribute("aria-invalid", "true")
    await description.fill("Corrected description")
    await expect(page.getByText(t("validation.line.description.required"), { exact: true })).toHaveCount(0)
    await expect(description).not.toHaveAttribute("aria-invalid", "true")
  })
}
