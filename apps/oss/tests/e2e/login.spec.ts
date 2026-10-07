import { expect, test } from "@playwright/test"
import {
  loginAsAdmin,
  resetDatabase,
  seedCompletedSetup,
  uniqueEmail,
  waitForClientReady,
} from "./support"

test.beforeEach(async () => {
  await resetDatabase()
})

test("lets the initial admin sign in to the dashboard", async ({ page }) => {
  test.skip(process.env.QUITS_DISTRIBUTION === "cloud", "Dashboard smoke is selfhost-only")

  await seedCompletedSetup()

  await loginAsAdmin(page)

  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible()
})

test("lets a new user sign up and continue to onboarding", async ({ page }) => {
  await seedCompletedSetup()

  await page.goto("/signup")
  await waitForClientReady(page)
  await page.getByLabel("Name").fill("New Signup User")
  await page.getByLabel("Email").fill(uniqueEmail("signup"))
  await page.getByLabel("Password").fill("SignupSmoke123!")
  await page.getByRole("button", { name: "Sign up" }).click()

  await expect(page).toHaveURL(/\/onboarding/)
  await expect(page.getByText("Create your organization")).toBeVisible()
})

test("shows adaptive cloud onboarding after organization creation", async ({ page }) => {
  test.skip(process.env.QUITS_DISTRIBUTION !== "cloud", "Cloud-only onboarding coverage")

  await seedCompletedSetup()

  await page.goto("/signup")
  await waitForClientReady(page)
  await page.getByLabel("Name").fill("Cloud Signup User")
  await page.getByLabel("Email").fill(uniqueEmail("cloud-signup"))
  await page.getByLabel("Password").fill("SignupSmoke123!")
  await page.getByRole("button", { name: "Sign up" }).click()

  await expect(page).toHaveURL(/\/onboarding/)
  await page.getByLabel("Organization name").fill("Nordic Advisory")
  await page.getByLabel("Slug").fill("nordic-advisory")
  await page.getByRole("button", { name: "Create organization" }).click()

  await expect(page.getByText("Finish organization setup")).toBeVisible()
  await page.getByLabel("Country").selectOption("DK")
  await expect(page.getByLabel("Locale")).toHaveValue("da-DK")
  await expect(page.getByLabel("Default currency")).toHaveValue("DKK")
  await expect(page.getByLabel("Timezone")).toHaveValue("Europe/Copenhagen")

  await page.getByRole("button", { name: /I invoice as an individual/i }).click()
  await expect(page.getByLabel("VAT/CVR number")).toHaveCount(0)

  await page
    .getByRole("button", { name: /I invoice through a registered business/i })
    .click()
  await expect(page.getByLabel("VAT/CVR number")).toBeVisible()
})
