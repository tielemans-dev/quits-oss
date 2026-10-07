import { defineConfig } from "@playwright/test"

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000"
const databaseUrl =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/yaip?schema=public"
const distribution =
  process.env.PLAYWRIGHT_QUITS_DISTRIBUTION ??
  process.env.PLAYWRIGHT_YAIP_DISTRIBUTION ??
  process.env.QUITS_DISTRIBUTION ??
  process.env.YAIP_DISTRIBUTION ??
  "selfhost"

export default defineConfig({
  testDir: "./tests/e2e",
  // This fixture needs its own fake-provider server and explicit throwaway database.
  testIgnore: "**/public-agreement.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
  webServer: {
    command:
      "bunx prisma generate && bunx prisma migrate deploy && bunx vite dev --port 3000 --host 127.0.0.1",
    cwd: import.meta.dirname,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    url: baseURL,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      BETTER_AUTH_SECRET:
        process.env.BETTER_AUTH_SECRET ?? "playwright-auth-secret-that-is-over-32-characters",
      BETTER_AUTH_URL: baseURL,
      VITE_QUITS_DISTRIBUTION: distribution,
      QUITS_APP_ORIGIN: baseURL,
      QUITS_DISTRIBUTION: distribution,
      QUITS_JSON_LOGS: "false",
      QUITS_PUBLIC_PAYMENT_SECRET:
        process.env.QUITS_PUBLIC_PAYMENT_SECRET ??
        process.env.YAIP_PUBLIC_PAYMENT_SECRET ??
        "payment-link-e2e-secret-123456",
      QUITS_PUBLIC_QUOTE_SECRET:
        process.env.QUITS_PUBLIC_QUOTE_SECRET ??
        process.env.YAIP_PUBLIC_QUOTE_SECRET ??
        "quote-link-e2e-secret-123456",
    },
  },
})
