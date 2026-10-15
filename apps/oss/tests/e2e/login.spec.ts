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

  await expect(page).toHaveURL(new URL("/", page.url()).href)
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible()
})

test("blocks organization deletion through the authenticated browser API and keeps the session usable", async ({ page }) => {
  const setup = await seedCompletedSetup()
  await loginAsAdmin(page)
  const response = await page.request.post("/api/auth/organization/delete", {
    headers: { origin: new URL(page.url()).origin },
    data: { organizationId: setup.organizationId },
  })
  expect(response.status()).toBe(404)
  expect(await response.json()).toMatchObject({ code: "ORGANIZATION_DELETION_DISABLED" })
  await page.reload()
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible()
})

test("lets a new user sign up and continue to onboarding", async ({ page }) => {
  const cloud = process.env.QUITS_DISTRIBUTION === "cloud"
  await seedCompletedSetup()

  await page.goto("/signup")
  await waitForClientReady(page)
  await page.getByLabel("Name").fill("New Signup User")
  await page.getByLabel("Email").fill(uniqueEmail("signup"))
  await page.getByLabel("Password").fill("SignupSmoke123!")
  await page.getByRole("button", { name: "Create account" }).click()

  await expect(page).toHaveURL(/\/onboarding/)
  await waitForClientReady(page)
  await expect(page.getByText(cloud ? "Look up your own CVR" : "Enter your company name")).toBeVisible()
  await expect(page.getByLabel("Slug")).toHaveCount(0)

  // No organization yet: the sidebar and its switcher stay off the page. The raw response
  // stays English with a pending app placeholder; the rendered page detects Danish.
  await page.addInitScript(() => Object.defineProperty(navigator, "language", { get: () => "da-DK" }))
  const response = await page.reload()
  expect(response!.ok()).toBe(true)
  const serverHtml = await response!.text()
  expect(serverHtml).toMatch(/<html\b[^>]*\blang="en"/)
  expect(serverHtml).not.toContain(">Invoices<")
  expect(serverHtml).not.toContain(">Fakturaer<")
  expect(serverHtml).not.toContain("Switch organization")
  expect(serverHtml).not.toContain("Skift organisation")
  await waitForClientReady(page)
  await expect(page.locator("html")).toHaveAttribute("lang", "da")
  await expect(page.getByText(cloud ? "Slå dit eget CVR op" : "Indtast virksomhedsnavnet", { exact: true })).toBeVisible()
  if (cloud) await expect(page.getByRole("button", { name: "Indtast manuelt" })).toBeVisible()
  else await expect(page.getByRole("button", { name: "Indtast manuelt" })).toHaveCount(0)
})

test("shows adaptive cloud onboarding after organization creation", async ({ page }) => {
  test.skip(process.env.QUITS_DISTRIBUTION !== "cloud", "Cloud-only onboarding coverage")

  await seedCompletedSetup()

  await page.goto("/signup")
  await waitForClientReady(page)
  await page.getByLabel("Name").fill("Cloud Signup User")
  await page.getByLabel("Email").fill(uniqueEmail("cloud-signup"))
  await page.getByLabel("Password").fill("SignupSmoke123!")
  await page.getByRole("button", { name: "Create account" }).click()

  await expect(page).toHaveURL(/\/onboarding/)
  await page.getByRole("button", { name: "Enter manually" }).click()
  await page.getByLabel("Company name").fill("Nordic Advisory")
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
