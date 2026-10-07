import { defineConfig } from "@playwright/test"
import base from "./playwright.config"

const databaseURL = process.env.DATABASE_URL
if (!databaseURL || new URL(databaseURL).pathname !== "/quits_a2b_browser") {
  throw new Error("Credit e2e requires the explicit throwaway database quits_a2b_browser")
}
const baseURL = "http://127.0.0.1:3004"
export default defineConfig({
  ...base, testMatch: "credits-v2.spec.ts", testIgnore: [],
  use: { ...base.use, baseURL },
  webServer: {
    command: "bunx prisma generate && bunx prisma migrate deploy && bunx vite dev --port 3004 --host 127.0.0.1",
    cwd: import.meta.dirname, reuseExistingServer: false, timeout: 120_000, url: baseURL,
    env: { ...process.env, DATABASE_URL: databaseURL, BETTER_AUTH_SECRET: "credit-browser-only-secret-over-32-characters",
      BETTER_AUTH_URL: baseURL, QUITS_APP_ORIGIN: baseURL, QUITS_DISTRIBUTION: "selfhost", VITE_QUITS_DISTRIBUTION: "selfhost" },
  },
})
