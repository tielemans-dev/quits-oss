import { configDefaults, defineConfig } from "vitest/config"
import { globalStateTests, playwrightTests } from "./vitest.config"

/** Runs the database-backed `*.integration.*` tests against `DATABASE_URL`. */
export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./src/test-utils/artifact-runtime.ts"],
    watch: false,
    // Bound PostgreSQL connections and memory when several worktrees verify concurrently.
    maxWorkers: 2,
    globals: false,
    // Preserve Vitest 3 mock history; Vitest 5 clears it before each test by default.
    clearMocks: false,
    // Tests share one PostgreSQL across parallel workers; vitest's 5s default times out under load.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: ["src/**/*.integration.test.{ts,tsx}"],
    exclude: [...configDefaults.exclude, ...playwrightTests, globalStateTests],
  },
})
