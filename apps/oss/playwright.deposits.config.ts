import { defineConfig } from "@playwright/test"
import base from "./playwright.config"

const databaseURL = process.env.DATABASE_URL
if (!databaseURL || !/^\/quits_deposits_browser(?:_[a-zA-Z0-9]+)?$/.test(new URL(databaseURL).pathname)) {
  throw new Error("Deposit e2e requires an explicit throwaway DATABASE_URL named quits_deposits_browser")
}
const baseURL = "http://127.0.0.1:3088"
export default defineConfig({
  ...base,
  testMatch: "deposit-capability.spec.ts",
  use: { ...base.use, baseURL },
  webServer: {
    ...base.webServer,
    command: "bunx prisma generate && bunx prisma migrate deploy && bunx vite dev --port 3088 --host 127.0.0.1",
    url: baseURL,
    reuseExistingServer: false,
    env: {
      ...process.env,
      DATABASE_URL: databaseURL,
      BETTER_AUTH_URL: baseURL,
      BETTER_AUTH_SECRET: "ws8-browser-only-secret-over-32-characters",
      QUITS_APP_ORIGIN: baseURL,
      QUITS_DISTRIBUTION: "selfhost",
    },
  },
})
