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
    watch: false,
    globals: false,
    exclude: [...configDefaults.exclude, "tests/e2e/**", globalStateTests],
  },
})
