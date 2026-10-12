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
    const reactPath = "/node_modules/.vite/deps/react.js"
    const domPath = "/node_modules/.vite/deps/react-dom_client.js"
    const formPath = "/src/components/auth/waitlist-form.tsx"
    const i18nPath = "/src/lib/i18n/react.tsx"
    const { createElement } = await import(/* @vite-ignore */ reactPath)
    const { createRoot } = await import(/* @vite-ignore */ domPath)
    const { WaitlistForm } = await import(/* @vite-ignore */ formPath)
    const { I18nProvider } = await import(/* @vite-ignore */ i18nPath)
    const fixture = document.createElement("main")
    document.body.replaceChildren(fixture)
    createRoot(fixture).render(createElement(I18nProvider, { locale: "en" }, createElement(WaitlistForm, {
      initialEmail: "person@example.test", privacyVersion: "2026-10-12.2", privacyPath: "/privacy",
      onJoined: (email: string) => {
        const heading = document.createElement("h1")
        heading.textContent = `Joined as ${email}`
        heading.tabIndex = -1
        fixture.replaceChildren(heading)
        heading.focus()
      },
    })))
  })
  const email = page.getByLabel("Email", { exact: true })
  const consent = page.getByRole("checkbox")
  const submit = page.getByRole("button", { name: "Join the waitlist" })
  await expect(consent).not.toBeChecked()
  await email.fill("person@example.t")
  await submit.click()
  await expect(email).toBeFocused()
  await expect(email).toHaveAttribute("aria-invalid", "true")
  await email.fill("still-invalid")
  await expect(email).toHaveAttribute("aria-invalid", "true")
  await email.fill("person@example.test")
  await expect(email).not.toHaveAttribute("aria-invalid", "true")
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
