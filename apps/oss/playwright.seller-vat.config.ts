import { defineConfig } from "@playwright/test"

const databaseURL = process.env.DATABASE_URL
if (!databaseURL || new URL(databaseURL).pathname !== "/qui62_oss_browser") {
  throw new Error("Seller VAT browser checks require the disposable qui62_oss_browser database")
}
const hosted = process.env.QUI62_HOSTED_FIXTURE === "true"
const baseURL = "http://127.0.0.1:3040"
export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: process.env.QUI62_EVIDENCE_REVISION === "before" ? "seller-vat-before.spec.ts" : "seller-vat-status.spec.ts",
  reporter: [["list"], ["html", { outputFolder: "playwright-report/seller-vat", open: "never" }]],
  workers: 1,
  timeout: 300_000,
  expect: { timeout: 30_000 },
  use: { baseURL, colorScheme: "light", viewport: { width: 1440, height: 1100 }, trace: "retain-on-failure" },
  webServer: {
    command: `bunx prisma migrate deploy && bunx vite dev ${hosted ? "--config vite.seller-vat.config.ts" : ""} --port 3040 --host 127.0.0.1`,
    cwd: import.meta.dirname,
    reuseExistingServer: false,
    timeout: 180_000,
    url: baseURL,
    env: { ...process.env, DATABASE_URL: databaseURL,
      PLAYWRIGHT_BASE_URL: baseURL,
      BETTER_AUTH_SECRET: "qui62-browser-test-secret-over-32-characters",
      BETTER_AUTH_URL: baseURL, QUITS_APP_ORIGIN: baseURL,
      QUITS_DISTRIBUTION: hosted ? "cloud" : "selfhost", VITE_QUITS_DISTRIBUTION: hosted ? "cloud" : "selfhost",
      QUI62_HOSTED_FIXTURE: hosted ? "true" : "false",
      QUITS_PUBLIC_PAYMENT_SECRET: "qui62-browser-payment-test-secret",
      // This server does not use TanStack devtools. The bus binds a hashed port in
      // the ephemeral range and crashes vite on EADDRINUSE. "off" skips it on this
      // branch. The before job still runs main's vite, which ignores that switch
      // and needs a port outside the ephemeral range.
      QUITS_DEVTOOLS_EVENT_BUS: "off",
      QUITS_DEVTOOLS_EVENT_BUS_PORT: "3041",
      RESEND_API_KEY: "", EMAIL_PROVIDER: "", SMTP_HOST: "",
    },
  },
})
