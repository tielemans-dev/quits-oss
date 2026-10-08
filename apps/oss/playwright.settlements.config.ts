import { defineConfig } from "@playwright/test"
import base from "./playwright.config"

const databaseURL = process.env.DATABASE_URL
if (!databaseURL || new URL(databaseURL).pathname !== "/quits_money_test") throw new Error("Settlement browser tests require the disposable quits_money_test database")
const baseURL = "http://127.0.0.1:3018"
export default defineConfig({
  ...base, testMatch: "settlement-receipts.spec.ts", testIgnore: [],
  use: { ...base.use, baseURL },
  webServer: {
    command: "bunx prisma generate && bunx prisma migrate deploy && bunx vite dev --port 3018 --host 127.0.0.1",
    cwd: import.meta.dirname, reuseExistingServer: false, timeout: 120_000, url: baseURL,
    env: { ...process.env, DATABASE_URL: databaseURL, BETTER_AUTH_SECRET: "settlement-browser-only-secret-over-32-characters", BETTER_AUTH_URL: baseURL, QUITS_APP_ORIGIN: baseURL, QUITS_DISTRIBUTION: "selfhost", VITE_QUITS_DISTRIBUTION: "selfhost" },
  },
})
