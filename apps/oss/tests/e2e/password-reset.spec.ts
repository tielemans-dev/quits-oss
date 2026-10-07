import { randomUUID } from "node:crypto"
import { Client } from "pg"
import { expect, test } from "@playwright/test"
import { waitForClientReady } from "./support"

// Recovery writes authentication credentials. Require an explicitly selected local test database.
const databaseUrl = process.env.DATABASE_URL
const localDatabase = databaseUrl && ["localhost", "127.0.0.1"].includes(new URL(databaseUrl).hostname)
test.skip(!localDatabase, "Requires an explicit disposable local DATABASE_URL")

test("recovers a local account through native reset tokens without sending email", async ({ page, request, baseURL }) => {
  // This test exercises failed-delivery confirmation while reading the disposable fixture's token.
  // Never run it with a configured provider: token lifecycle is also covered by memory-adapter tests.
  test.skip(Boolean(process.env.RESEND_API_KEY || process.env.SMTP_HOST), "Requires email delivery to be disabled")
  const client = new Client({ connectionString: databaseUrl })
  await client.connect()
  const email = `recovery-${randomUUID()}@example.com`
  let userId: string | undefined
  try {
    const signedUp = await request.post("/api/auth/sign-up/email", {
      data: { email, name: "Recovery Test", password: "old-test-password123" },
      headers: { origin: baseURL! },
    })
    expect(signedUp.status()).toBe(200)
    userId = (await signedUp.json()).user.id
    await page.goto("/login")
    await waitForClientReady(page)
    await page.getByRole("link", { name: "Forgot password?" }).click()
    await waitForClientReady(page)
    await page.getByLabel("Email").fill(email)
    await expect(page.getByLabel("Email")).toHaveValue(email)
    await page.getByRole("button", { name: "Send reset link" }).click()
    await expect(page.getByRole("status")).toContainText("If an account exists")
    const verification = await client.query<{ identifier: string }>(
      'SELECT identifier FROM verification WHERE value = $1 AND identifier LIKE \'reset-password:%\' ORDER BY "createdAt" DESC LIMIT 1', [userId],
    )
    const token = verification.rows[0]!.identifier.slice("reset-password:".length)
    await page.goto(`/api/auth/reset-password/${encodeURIComponent(token)}?callbackURL=${encodeURIComponent(`${baseURL}/reset-password`)}`)
    await waitForClientReady(page)
    await page.getByLabel("New password", { exact: true }).fill("new-test-password456")
    await page.getByLabel("Confirm password").fill("mismatched-test-password")
    await page.getByRole("button", { name: "Save new password" }).click()
    await expect(page.getByRole("alert")).toHaveText("The passwords do not match.")
    await page.getByLabel("Confirm password").fill("new-test-password456")
    await page.getByRole("button", { name: "Save new password" }).click()
    await expect(page.getByRole("status")).toContainText("Your password has been reset")
    await expect(page).toHaveURL(`${baseURL}/reset-password`)
    const sessions = await client.query('SELECT id FROM session WHERE "userId" = $1', [userId])
    expect(sessions.rows).toHaveLength(0)
    await page.getByRole("link", { name: "Back to log in" }).click()
    const oldLogin = await request.post("/api/auth/sign-in/email", {
      data: { email, password: "old-test-password123" }, headers: { origin: baseURL! },
    })
    expect(oldLogin.status()).toBe(401)
    const newLogin = await request.post("/api/auth/sign-in/email", {
      data: { email, password: "new-test-password456" }, headers: { origin: baseURL! },
    })
    expect(newLogin.status()).toBe(200)
    await page.goto(`/reset-password?token=${encodeURIComponent(token)}`)
    await waitForClientReady(page)
    await page.getByLabel("New password", { exact: true }).fill("third-test-password789")
    await page.getByLabel("Confirm password").fill("third-test-password789")
    await page.getByRole("button", { name: "Save new password" }).click()
    await expect(page.getByRole("alert")).toContainText("invalid or has expired")
    await expect(page.getByRole("link", { name: "Request a new reset link" })).toHaveAttribute("href", "/forgot-password")
  } finally {
    if (userId) {
      await client.query("DELETE FROM verification WHERE value = $1", [userId])
      await client.query('DELETE FROM "user" WHERE id = $1', [userId])
    }
    await client.end()
  }
})
