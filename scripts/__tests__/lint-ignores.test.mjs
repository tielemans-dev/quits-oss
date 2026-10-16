import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"

test("Vite+ excludes vendored and generated code with bare and explicit paths", (t) => {
  const source = fileURLToPath(new URL("../../", import.meta.url))
  const root = realpathSync(mkdtempSync(join(tmpdir(), "quits-lint-ignores-")))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  symlinkSync(join(source, "node_modules"), join(root, "node_modules"), "dir")
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "lint-fixture", private: true, type: "module" }))
  for (const name of ["vite.config.ts", ".eslintignore"]) {
    if (existsSync(join(source, name))) writeFileSync(join(root, name), readFileSync(join(source, name)))
  }
  for (const folder of ["docs/vendor", "apps/oss/build", "src"]) mkdirSync(join(root, folder), { recursive: true })
  writeFileSync(join(root, "src/kept.ts"), "export const value = 1\n")
  for (const folder of ["docs/vendor", "apps/oss/build"]) writeFileSync(join(root, folder, "sentinel.ts"), "const =\n")
  const lint = (args) => spawnSync(join(source, "node_modules/.bin/vp"), ["lint", ...args], {
    cwd: root, encoding: "utf8", env: { ...process.env, QUITS_WORKTREE_ENV: "1" },
  })
  for (const paths of [[], ["docs/vendor", "apps/oss", "src"],
    ["docs/vendor/sentinel.ts", "apps/oss/build/sentinel.ts", "src/kept.ts"]]) {
    const result = lint(paths)
    assert.equal(result.status, 0, (result.stdout + result.stderr).slice(-2000))
  }
  const control = lint(["--no-ignore", "docs/vendor/sentinel.ts"])
  assert.notEqual(control.status, 0, "the sentinel must fail when ignores are disabled")
})
