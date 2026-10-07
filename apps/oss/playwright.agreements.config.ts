import { defineConfig } from "@playwright/test"
import base from "./playwright.config"

/** Isolated agreement flow with a local fake provider. Supply a throwaway DATABASE_URL. */
const databaseURL = process.env.DATABASE_URL
if (
  !databaseURL ||
  !/^\/quits_agreements_browser(?:_[a-zA-Z0-9]+)?$/.test(new URL(databaseURL).pathname)
) {
  throw new Error(
    "Agreement e2e requires an explicit throwaway DATABASE_URL named quits_agreements_browser (optionally with a suffix)",
  )
}
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3015"
export default defineConfig({
  ...base,
  testMatch: "public-agreement.spec.ts",
  testIgnore: [],
  use: { ...base.use, baseURL },
  webServer: {
    command:
      "bunx prisma generate && bunx prisma migrate deploy && bunx vite dev --port 3015 --host 127.0.0.1",
    cwd: import.meta.dirname,
    reuseExistingServer: false,
    timeout: 120_000,
    url: baseURL,
    env: {
      ...process.env,
      DATABASE_URL: databaseURL,
      BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? "agreement-browser-only-secret-over-32-characters",
      BETTER_AUTH_URL: baseURL,
      QUITS_APP_ORIGIN: baseURL,
      QUITS_DISTRIBUTION: "selfhost",
      VITE_QUITS_DISTRIBUTION: "selfhost",
      RESEND_API_KEY: "re_synthetic_agreement_browser",
      FROM_EMAIL: "billing@example.test",
      RESEND_BASE_URL: "http://127.0.0.1:3059",
    },
  },
})
