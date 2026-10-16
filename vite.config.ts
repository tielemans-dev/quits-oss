import { defineConfig } from "vite-plus"

export default defineConfig({
  run: { cache: false },
  // Path exclusions live in .eslintignore so explicit CLI paths are excluded too.
  lint: {},
  fmt: {
    semi: false,
    ignorePatterns: [
      "docs/vendor/**",
      ".repos/**",
      ".artifacts/**",
      "**/generated/**",
      "**/routeTree.gen.ts",
      "**/.output/**",
      "bun.lock",
    ],
  },
})
