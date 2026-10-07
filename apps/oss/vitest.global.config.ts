import { configDefaults, defineConfig } from "vitest/config"
import { globalStateTests } from "./vitest.config"

/** Runs the tests that depend on database-wide state, alone and one file at a time. */
export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./src/test-utils/artifact-runtime.ts"],
    watch: false,
    globals: false,
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: [globalStateTests.replace("**/*", "src/**/*") + ".test.ts"],
    exclude: [...configDefaults.exclude, "tests/e2e/**"],
  },
})
