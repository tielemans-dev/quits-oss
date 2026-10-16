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

  await expect(page.getByText("Opsæt din Quits-instans")).toBeVisible()

  await page.getByRole("button", { name: "Næste" }).click()
  await page.getByLabel("CVR-nr.").fill("24256790")
  await page.getByLabel("Organisationsnavn").fill("Setup Smoke Org")
  await page.getByLabel("Administratornavn").fill("Setup Smoke Admin")
  await page.getByLabel("Administrator-e-mail").fill(adminEmail)
  await page.getByLabel("Administratoradgangskode").fill(adminPassword)
  await page.getByRole("button", { name: "Næste" }).click()
  await page.getByRole("button", { name: "Næste" }).click()
  await expect(page.getByLabel("Sprog")).toHaveValue("da-DK")
  await expect(page.getByLabel("Landekode")).toHaveValue("DK")
  await expect(page.getByLabel("Tidszone")).toHaveValue("Europe/Copenhagen")
  await expect(page.getByLabel("Valuta")).toHaveValue("DKK")
  await page.getByLabel("E-mail-afsendernavn (valgfrit)").fill("Setup Billing")
  await page.getByLabel("E-mail-svar-til (valgfrit)").fill("billing@example.com")
  await page.getByRole("button", { name: "Afslut opsætning" }).click()

  await expect(page).toHaveURL(/\/login/)
  await expect(page.getByRole("status")).toContainText(
    "Opsætningen er fuldført. Log ind for at fortsætte."
  )

  await page.getByLabel("Email").fill(adminEmail)
  await page.getByLabel("Password").fill(adminPassword)
  await page.getByRole("button", { name: "Log in" }).click()
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
    timeout: 10_000,
  })
  await waitForClientReady(page)

  await page.goto("/settings")
  await waitForClientReady(page)

  await expect(page.getByLabel("Virksomhedsnavn", { exact: true })).toHaveValue("Setup Billing")
  await expect(page.getByLabel("Virksomheds-e-mail", { exact: true })).toHaveValue("billing@example.com")
})
