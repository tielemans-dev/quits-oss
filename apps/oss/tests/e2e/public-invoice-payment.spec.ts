import { expect, test } from "@playwright/test"
import { prisma } from "../../src/lib/db"
import { resetDatabase, seedPublicInvoice, waitForClientReady } from "./support"

test.beforeEach(async () => {
  await resetDatabase()
})

test("renders a public invoice payment page with checkout available", async ({ page }) => {
  const invoice = await seedPublicInvoice()

  await page.goto(invoice.url)
  await waitForClientReady(page)

  await expect(page.getByText(invoice.number)).toBeVisible()
  await expect(page.getByRole("button", { name: "Pay now" })).toBeVisible()
  await expect(page.getByText("Invoice from E2E Org")).toBeVisible()
})

test("keeps the payment link of an invoice credited in full, without a payment button", async ({ page }) => {
  const invoice = await seedPublicInvoice()
  await prisma.invoice.update({
    where: { id: invoice.id },
    data: { status: "credited", amountCredited: "250.00" },
  })

  await page.goto(invoice.url)
  await waitForClientReady(page)

  await expect(page.getByText(invoice.number)).toBeVisible()
  await expect(page.getByText("Invoice credited")).toBeVisible()
  await expect(page.getByText("This invoice has been credited in full. Nothing is due.")).toBeVisible()
  await expect(page.getByRole("button", { name: "Pay now" })).toHaveCount(0)
})
