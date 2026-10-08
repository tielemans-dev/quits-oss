import { resolve } from "node:path"
import { defineConfig } from "@playwright/test"
import base from "./playwright.config"

/** Isolated client action page flow with a local fake provider. Supply a throwaway DATABASE_URL. */
const databaseURL = process.env.DATABASE_URL
if (
  !databaseURL ||
  !/^\/quits_client_actions_browser(?:_[a-zA-Z0-9]+)?$/.test(new URL(databaseURL).pathname)
) {
  throw new Error(
    "Client action e2e requires an explicit throwaway DATABASE_URL named quits_client_actions_browser (optionally with a suffix)",
  )
}
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:4387"
const port = new URL(baseURL).port
const mailbox = resolve(process.env.CLIENT_ACTIONS_MAILBOX ?? "test-results/client-actions-mail.jsonl")
export default defineConfig({
  ...base,
  testMatch: "client-actions.spec.ts",
  testIgnore: [],
  use: { ...base.use, baseURL },
  webServer: {
    command:
      `bunx prisma migrate deploy && bunx vite dev --config vite.client-actions.config.ts --port ${port} --strictPort --host 127.0.0.1`,
    cwd: import.meta.dirname,
    reuseExistingServer: false,
    timeout: 120_000,
    url: baseURL,
    env: {
      ...process.env,
      DATABASE_URL: databaseURL,
      BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? "client-actions-browser-only-secret-over-32-characters",
      BETTER_AUTH_URL: baseURL,
      QUITS_APP_ORIGIN: baseURL,
      QUITS_DISTRIBUTION: "selfhost",
      VITE_QUITS_DISTRIBUTION: "selfhost",
      RESEND_API_KEY: "re_synthetic_client_actions_browser",
      FROM_EMAIL: "billing@example.test",
      RESEND_BASE_URL: `${baseURL}/__client-actions-email`,
      CLIENT_ACTIONS_MAILBOX: mailbox,
    },
  },
})
