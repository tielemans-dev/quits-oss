import { expect, test } from "@playwright/test"
import { resetDatabase, seedCompletedSetup, waitForClientReady } from "./support"

// Exercise the public OSS component in Chromium. Admission and waitlist storage remain
// hosted runtime responsibilities; the HTTP responses below are contract fixtures.
test("waitlist validation, consent rejection and bodyless success preserve focus", async ({ page }, testInfo) => {
  await resetDatabase()
  await seedCompletedSetup()
  await page.goto("/signup")
  await waitForClientReady(page)
  await page.evaluate(async () => {
    const fixturePath = "/tests/e2e/fixtures/waitlist-form.tsx"
    const { mountWaitlistForm } = await import(/* @vite-ignore */ fixturePath)
    mountWaitlistForm()
  })
  const email = page.getByLabel("Email", { exact: true })
  const consent = page.getByRole("checkbox")
  const submit = page.getByRole("button", { name: "Join the waitlist" })
  await expect(consent).not.toBeChecked()
  await email.fill("person@example.t")
  await submit.click()
  await expect(email).toBeFocused()
  await expect(email).toHaveAttribute("aria-invalid", "true")
  await submit.click()
  await expect(email).toBeFocused()
  await email.fill("still-invalid")
  await expect(email).toHaveAttribute("aria-invalid", "true")
  await email.fill("person@example.test")
  await expect(email).not.toHaveAttribute("aria-invalid", "true")
  await email.fill("person@example.t")
  await submit.click()
  await expect(email).toBeFocused()
  await expect(email).toHaveAttribute("aria-invalid", "true")
  await email.fill("person@example.test")
  await consent.check()
  await page.route("**/api/waitlist", (route) => route.fulfill({ status: 422, json: { error: "consent_required" } }))
  await submit.click()
  await expect(consent).toBeFocused()
  await expect(consent).not.toBeChecked()
  await expect(consent).toHaveAttribute("aria-describedby", "waitlist-consent-error")
  await page.screenshot({ path: testInfo.outputPath("waitlist-consent-error.png"), fullPage: true })
  await page.unroute("**/api/waitlist")
  await page.route("**/api/waitlist", async (route) => {
    expect(route.request().postDataJSON()).toEqual({ email: "person@example.test", consent: true,
      privacyVersion: "2026-10-12.2", locale: "en", source: "app-signup", note: "", honeypot: "" })
    await route.fulfill({ status: 204 })
  })
  await consent.check()
  await submit.click()
  await expect(page.getByRole("heading", { name: "Joined as person@example.test" })).toBeFocused()
})
