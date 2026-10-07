import { expect, test } from "@playwright/test"
import { resetDatabase, waitForClientReady } from "./support"

test.beforeEach(async () => {
  await resetDatabase()
})

test("completes the setup wizard and lands on login", async ({ page }) => {
  test.skip(process.env.QUITS_DISTRIBUTION === "cloud", "Setup wizard is selfhost-only")

  const adminEmail = "setup-admin@example.com"
  const adminPassword = "SetupSmoke123!"

  await page.goto("/setup")
  await waitForClientReady(page)

  await expect(page.getByText("Set up your Quits instance")).toBeVisible()

  await page.getByRole("button", { name: "Next" }).click()
  await page.getByLabel("Organization name").fill("Setup Smoke Org")
  await page.getByLabel("Admin name").fill("Setup Smoke Admin")
  await page.getByLabel("Admin email").fill(adminEmail)
  await page.getByLabel("Admin password").fill(adminPassword)
  await page.getByRole("button", { name: "Next" }).click()
  await page.getByRole("button", { name: "Next" }).click()
  await page.getByLabel("Email from name (optional)").fill("Setup Billing")
  await page.getByLabel("Email reply-to (optional)").fill("billing@example.com")
  await page.getByRole("button", { name: "Finish setup" }).click()

  await expect(page).toHaveURL(/\/login/)
  await expect(page.getByRole("status")).toContainText(
    "Setup complete. Please sign in to continue."
  )

  await page.getByLabel("Email").fill(adminEmail)
  await page.getByLabel("Password").fill(adminPassword)
  await page.getByRole("button", { name: "Sign in" }).click()
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
    timeout: 10_000,
  })
  await waitForClientReady(page)

  await page.goto("/settings")
  await waitForClientReady(page)

  await expect(page.getByLabel("Company Name")).toHaveValue("Setup Billing")
  await expect(page.getByLabel("Company Email")).toHaveValue("billing@example.com")
})
