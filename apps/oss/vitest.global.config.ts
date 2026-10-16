import { configDefaults, defineConfig } from "vitest/config"
import { globalStateTests, playwrightTests } from "./vitest.config"

/** Runs the tests that depend on database-wide state, alone and one file at a time. */
export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./src/test-utils/artifact-runtime.ts"],
    watch: false,
    globals: false,
    // Preserve Vitest 3 mock history; Vitest 5 clears it before each test by default.
    clearMocks: false,
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: [globalStateTests.replace("**/*", "src/**/*") + ".test.ts"],
    exclude: [...configDefaults.exclude, ...playwrightTests],
  },
})
