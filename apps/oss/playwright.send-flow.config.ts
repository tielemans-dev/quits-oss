import { defineConfig } from "@playwright/test"
import base from "./playwright.config"

const databaseURL = process.env.DATABASE_URL
if (!databaseURL || !/^\/quits_qui60_browser$/.test(new URL(databaseURL).pathname)) {
  throw new Error("Send-flow e2e requires the explicit throwaway database quits_qui60_browser")
}
const baseURL = "http://127.0.0.1:31461"
const serverEnv = {
  ...process.env, DATABASE_URL: databaseURL,
  BETTER_AUTH_SECRET: "qui60-browser-only-secret-over-thirty-two-characters",
  BETTER_AUTH_URL: baseURL, QUITS_APP_ORIGIN: baseURL,
  QUITS_DISTRIBUTION: "selfhost", VITE_QUITS_DISTRIBUTION: "selfhost",
  RESEND_API_KEY: "re_synthetic_qui60", FROM_EMAIL: "billing@example.test",
  RESEND_BASE_URL: "http://127.0.0.1:31560", EMAIL_PROVIDER: "resend",
  QUITS_ARTIFACT_DIR: process.env.QUITS_ARTIFACT_DIR ?? `${import.meta.dirname}/../../.tmp/qui60/browser-artifacts`,
  QUITS_DEVTOOLS_EVENT_BUS_PORT: "41461",
}
export default defineConfig({
  ...base, testMatch: "invoice-send-flow.spec.ts", testIgnore: [],
  timeout: 120_000, use: { ...base.use, baseURL, colorScheme: "light" },
  webServer: [
    { command: "bunx vite dev --port 31461 --host 127.0.0.1", cwd: import.meta.dirname,
      reuseExistingServer: false, timeout: 120_000, url: baseURL, env: serverEnv },
    ...(process.env.QUI60_BASELINE_ROOT ? [{
      command: "bunx vite dev --port 31460 --host 127.0.0.1",
      cwd: `${process.env.QUI60_BASELINE_ROOT}/apps/oss`, reuseExistingServer: false,
      timeout: 120_000, url: "http://127.0.0.1:31460",
      env: { ...serverEnv, BETTER_AUTH_URL: "http://127.0.0.1:31460", QUITS_APP_ORIGIN: "http://127.0.0.1:31460", QUITS_DEVTOOLS_EVENT_BUS_PORT: "41460" },
    }] : []),
  ],
})
