import { configDefaults, defineConfig } from "vitest/config"

/**
 * Tests named `*.global.*` depend on database-wide state (e.g. counts of every organization), so
 * test files running in parallel would change it under them. They are excluded here and run on
 * their own, one file at a time, by `vitest.global.config.ts`.
 */
export const globalStateTests = "**/*.global.*"

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./src/test-utils/artifact-runtime.ts"],
    watch: false,
    // Bound PostgreSQL connections and memory when several worktrees verify concurrently.
    maxWorkers: 4,
    globals: false,
    // Database-backed tests share one PostgreSQL across parallel workers and migrate schemas on
    // first use; vitest's 5s default times out under load (locally and on CI).
    testTimeout: 30_000,
    hookTimeout: 30_000,
    exclude: [...configDefaults.exclude, "tests/e2e/**", "tests/shared/**", globalStateTests],
  },
})
