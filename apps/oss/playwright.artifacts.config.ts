import { defineConfig } from "@playwright/test"
import base from "./playwright.config"
const databaseURL = process.env.DATABASE_URL
if (!databaseURL || !/^\/quits_artifacts_browser(?:_[a-zA-Z0-9]+)?$/.test(new URL(databaseURL).pathname)) {
  throw new Error("Artifact e2e requires an explicit throwaway DATABASE_URL named quits_artifacts_browser")
}
const baseURL = "http://127.0.0.1:3018"
export default defineConfig({
  ...base, testMatch: "document-artifacts.spec.ts", testIgnore: [],
  use: { ...base.use, baseURL },
  webServer: {
    command: "bunx prisma generate && bunx prisma migrate deploy && bunx vite dev --port 3018 --host 127.0.0.1",
    cwd: import.meta.dirname, reuseExistingServer: false, timeout: 120_000, url: baseURL,
    env: {
      ...process.env, DATABASE_URL: databaseURL,
      BETTER_AUTH_SECRET: "artifact-browser-only-secret-over-thirty-two-characters",
      BETTER_AUTH_URL: baseURL, QUITS_APP_ORIGIN: baseURL,
      QUITS_DEVTOOLS_EVENT_BUS_PORT: "42618",
      QUITS_DISTRIBUTION: "selfhost", VITE_QUITS_DISTRIBUTION: "selfhost",
      RESEND_API_KEY: "re_synthetic_artifacts", FROM_EMAIL: "billing@example.test",
      RESEND_BASE_URL: "http://127.0.0.1:3058",
      QUITS_ARTIFACT_DIR: process.env.QUITS_ARTIFACT_DIR ?? "/var/tmp/quits-a3a/browser-artifacts",
    },
  },
})
