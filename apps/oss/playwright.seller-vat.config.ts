import { defineConfig } from "@playwright/test"

const databaseURL = process.env.DATABASE_URL
if (!databaseURL || new URL(databaseURL).pathname !== "/qui62_oss_browser") {
  throw new Error("Seller VAT browser checks require the disposable qui62_oss_browser database")
}
const baseURL = "http://127.0.0.1:3040"
export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "seller-vat-status.spec.ts",
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 30_000 },
  use: { baseURL, colorScheme: "light", viewport: { width: 1440, height: 1100 }, trace: "retain-on-failure" },
  webServer: {
    command: "bunx prisma migrate deploy && bunx vite dev --port 3040 --host 127.0.0.1",
    cwd: import.meta.dirname,
    reuseExistingServer: true,
    timeout: 180_000,
    url: baseURL,
    env: { ...process.env, DATABASE_URL: databaseURL,
      BETTER_AUTH_SECRET: "qui62-browser-test-secret-over-32-characters",
      BETTER_AUTH_URL: baseURL, QUITS_APP_ORIGIN: baseURL,
      QUITS_DISTRIBUTION: "selfhost", VITE_QUITS_DISTRIBUTION: "selfhost",
      QUITS_PUBLIC_PAYMENT_SECRET: "qui62-browser-payment-test-secret",
      RESEND_API_KEY: "", EMAIL_PROVIDER: "", SMTP_HOST: "",
    },
  },
})
