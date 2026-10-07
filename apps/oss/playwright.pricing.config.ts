import { defineConfig } from "@playwright/test"
import base from "./playwright.config"

const databaseURL = process.env.DATABASE_URL
if (!databaseURL || new URL(databaseURL).pathname !== "/quits_a2a2_browser") {
  throw new Error("Pricing e2e requires the explicit throwaway database quits_a2a2_browser")
}
const baseURL = "http://127.0.0.1:3002"
export default defineConfig({
  ...base,
  testMatch: "pricing-v2.spec.ts",
  testIgnore: [],
  use: { ...base.use, baseURL },
  webServer: {
    command: "bunx prisma generate && bunx prisma migrate deploy && bunx vite dev --port 3002 --host 127.0.0.1",
    cwd: import.meta.dirname,
    reuseExistingServer: false,
    timeout: 120_000,
    url: baseURL,
    env: {
      ...process.env,
      DATABASE_URL: databaseURL,
      BETTER_AUTH_SECRET: "pricing-browser-only-secret-over-32-characters",
      BETTER_AUTH_URL: baseURL,
      QUITS_APP_ORIGIN: baseURL,
      QUITS_DISTRIBUTION: "selfhost",
      VITE_QUITS_DISTRIBUTION: "selfhost",
      QUITS_PUBLIC_QUOTE_SECRET: "quote-link-e2e-secret-123456",
      RESEND_API_KEY: "re_synthetic_pricing_browser",
      FROM_EMAIL: "billing@example.test",
      RESEND_BASE_URL: "http://127.0.0.1:3058",
    },
  },
})
