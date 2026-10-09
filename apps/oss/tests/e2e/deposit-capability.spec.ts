import { expect, test } from "@playwright/test"
import { loginAsAdmin, resetDatabase, seedCompletedSetup, waitForClientReady } from "./support"

test("the agreement editor follows the runtime deposit capability", async ({ page }, testInfo) => {
  await resetDatabase()
  await seedCompletedSetup()
  await loginAsAdmin(page)
  await page.goto("/agreements/new")
  await waitForClientReady(page)
  await expect(page.getByLabel("Title", { exact: true })).toBeVisible()
  const depositsEnabled = process.env.QUITS_DEPOSITS_ENABLED !== "false"
  await expect(page.getByRole("checkbox", { name: "Payment schedule line", exact: true })).toHaveCount(depositsEnabled ? 1 : 0)
  await expect(page.getByLabel("Deliverable title", { exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Add deliverable", exact: true })).toBeEnabled()
  await page.screenshot({ path: testInfo.outputPath(depositsEnabled ? "deposits-enabled.png" : "deposits-disabled.png"), fullPage: true })
})
