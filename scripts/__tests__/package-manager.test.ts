import { existsSync, readFileSync, readdirSync } from "node:fs"

import { describe, expect, it } from "vitest"

describe("repository Bun contract", () => {
  it("launches browser servers and builds through the installed Vite+ CLI", () => {
    const app = new URL("../../apps/oss/", import.meta.url)
    for (const file of readdirSync(app).filter((name) => /^playwright.*\.config\.ts$/.test(name))) {
      const text = readFileSync(new URL(file, app), "utf8")
      if (!text.includes("webServer:")) continue
      expect(text, file).not.toMatch(/bunx\s+vite\b/)
      expect(text, file).toContain("bunx --no-install vp dev")
    }
    for (const file of ["run.mjs", "qui52-runner.mjs"]) {
      const text = readFileSync(new URL(`e2e/${file}`, app), "utf8")
      expect(text, file).toContain("['--no-install', 'vp', 'build']")
    }
  })

  it("declares Bun as package manager and pins a Bun version file", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8")
    ) as {
      packageManager?: string
      workspaces?: string[]
    }

    expect(packageJson.packageManager).toMatch(/^bun@/)
    expect(packageJson.workspaces).toEqual([".", "apps/*", "packages/*", "scripts"])
    expect(existsSync(new URL("../../.bun-version", import.meta.url))).toBe(true)
  })

  it("does not keep pnpm in active package scripts or helper commands", () => {
    const files = [
      "package.json",
      "apps/oss/package.json",
      "packages/contracts/package.json",
      "packages/shared/package.json",
      "scripts/package.json",
      "scripts/predev-bootstrap.mjs",
      "scripts/check-packed-build.mjs",
      "apps/oss/playwright.config.ts",
    ]

    for (const file of files) {
      const text = readFileSync(new URL(`../../${file}`, import.meta.url), "utf8")
      expect(text).not.toContain("pnpm")
    }
  })

  it("does not leave pnpm in contributor-facing docs or workflows", () => {
    const files = [
      ".github/workflows/ci.yml",
      ".github/workflows/oss-boundary.yml",
      ".github/workflows/publish-package.yml",
      "README.md",
      "apps/oss/README.md",
      "CONTRIBUTING.md",
      "AGENTS.md",
      "CLAUDE.md",
    ]

    for (const file of files) {
      const text = readFileSync(new URL(`../../${file}`, import.meta.url), "utf8")
      expect(text).not.toContain("pnpm")
    }
  })
})
