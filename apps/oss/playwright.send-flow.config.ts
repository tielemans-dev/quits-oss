import { defineConfig } from "@playwright/test"
import base from "./playwright.config"

const databaseURL = process.env.DATABASE_URL
if (!databaseURL || new URL(databaseURL).pathname !== "/quits_send_flow_browser") {
  throw new Error("Send-flow e2e requires the explicit throwaway database quits_send_flow_browser")
}
const baseURL = "http://127.0.0.1:3061"
export default defineConfig({
  ...base,
  testMatch: "invoice-send-flow.spec.ts",
  testIgnore: [],
  timeout: 120_000,
  reporter: [["list"], ["html", { outputFolder: "playwright-report/send-flow", open: "never" }]],
  use: { ...base.use, baseURL, colorScheme: "light" },
  webServer: {
    command: "bunx prisma generate && bunx prisma migrate deploy && bunx vite dev --port 3061 --host 127.0.0.1",
    cwd: import.meta.dirname,
    reuseExistingServer: false,
    timeout: 180_000,
    url: baseURL,
    env: {
      ...process.env,
      DATABASE_URL: databaseURL,
      BETTER_AUTH_SECRET: "send-flow-browser-only-secret-over-32-characters",
      BETTER_AUTH_URL: baseURL,
      QUITS_APP_ORIGIN: baseURL,
      QUITS_DISTRIBUTION: "selfhost",
      VITE_QUITS_DISTRIBUTION: "selfhost",
      RESEND_API_KEY: "re_synthetic_send_flow",
      FROM_EMAIL: "billing@example.test",
      EMAIL_PROVIDER: "resend",
      RESEND_BASE_URL: "http://127.0.0.1:3062",
      // The dev server does not use TanStack devtools; its bus would bind a hashed port and can crash on EADDRINUSE.
      QUITS_DEVTOOLS_EVENT_BUS: "off",
      QUITS_DEVTOOLS_EVENT_BUS_PORT: "3063",
    },
  },
})
