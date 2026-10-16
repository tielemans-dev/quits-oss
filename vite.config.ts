import { defineConfig } from "vite-plus"

export default defineConfig({
  run: { cache: false },
  lint: {
    ignorePatterns: [
      "docs/vendor/**",
      ".repos/**",
      "build/**",
      "apps/oss/build/**",
      "apps/oss/generated/**",
      "generated/**",
      "node_modules/**",
      "src/routeTree.gen.ts",
      "apps/oss/src/routeTree.gen.ts",
    ],
  },
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
