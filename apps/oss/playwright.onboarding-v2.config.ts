import { defineConfig } from "@playwright/test"
export default defineConfig({
  testDir: "./tests/onboarding-v2",
  testMatch: "*.spec.ts",
  workers: 1,
  use: { baseURL: "http://127.0.0.1:4316", trace: "retain-on-failure" },
  reporter: [["list"]],
  webServer: {
    command: "bunx --no-install vp dev --config tests/onboarding-v2/vite.config.ts",
    url: "http://127.0.0.1:4316",
    reuseExistingServer: !process.env.CI,
  },
})
