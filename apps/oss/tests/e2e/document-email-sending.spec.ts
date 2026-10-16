import { expect, test } from "@playwright/test"
import {
  loginAsAdmin,
  resetDatabase,
  seedCompletedSetup,
  waitForClientReady,
} from "./support"

test.beforeEach(async () => {
  await resetDatabase()
})

test("shows email delivery and document sending settings for an authenticated admin", async ({
  page,
}) => {
  await seedCompletedSetup()
  await loginAsAdmin(page)

  await page.goto("/settings/email")
  await waitForClientReady(page)

  await expect(page.getByRole("heading", { name: "Email", exact: true })).toBeVisible()
  await expect(page.getByText("Email Delivery")).toBeVisible()
  await expect(page.getByText("Missing env vars")).toBeVisible()
})
