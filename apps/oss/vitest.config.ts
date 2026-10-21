import { configDefaults, defineConfig } from "vitest/config"

/**
 * Tests named `*.global.*` depend on database-wide state (e.g. counts of every organization), so
 * test files running in parallel would change it under them. They are excluded here and run on
 * their own, one file at a time, by `vitest.global.config.ts`.
 */
export const globalStateTests = "**/*.global.*"

/** Tests that need PostgreSQL. They run through `vitest.integration.config.ts`, never in a unit run. */
export const integrationTests = "**/*.integration.*"

/** Browser suites are collected by their Playwright configs, not Vitest. */
export const playwrightTests = [
  "tests/e2e/**",
  "tests/shared/**",
  "tests/onboarding-v2/**",
  "tests/quality/**",
]

export default defineConfig({
  test: {
    environment: "node",
    css: { include: [/motion-tokens\.css/] },
    setupFiles: ["./src/test-utils/artifact-runtime.ts"],
    watch: false,
    // Unit tests never reach a database, whatever the shell or a `.env` provides. Prisma throws
    // "DATABASE_URL is not configured"; name a test `*.integration.test.ts` if it needs one.
    env: { DATABASE_URL: "" },
    maxWorkers: 2,
    globals: false,
    // Preserve Vitest 3 mock history; Vitest 5 clears it before each test by default.
    clearMocks: false,
    // Vitest's 5s default times out under load when several worktrees verify concurrently.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    exclude: [...configDefaults.exclude, ...playwrightTests, globalStateTests, integrationTests],
  },
})
