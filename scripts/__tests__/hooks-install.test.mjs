import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"

test("fresh frozen install leaves hooks opt-in", (t) => {
  const source = fileURLToPath(new URL("../../", import.meta.url))
  const root = mkdtempSync(join(tmpdir(), "quits-hook-install-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  // Dependency patches are part of the install: a frozen install fails without them.
  const manifests = execFileSync("git", ["ls-files", "-z", "--", "package.json", "*/package.json", "patches/*.patch"], {
    cwd: source, encoding: "utf8",
  }).split("\0").filter(Boolean)
  for (const path of [...manifests, "bun.lock", "lefthook.yml", "scripts/lefthook.sh"]) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    copyFileSync(join(source, path), join(root, path))
  }
  const run = (command, args) => {
    const result = spawnSync(command, args, {
      cwd: root, encoding: "utf8", timeout: 300_000,
      // Exercise the developer install path even on CI, without machine Git configuration.
      env: { ...process.env, CI: "", LEFTHOOK: "1", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    })
    assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`)
  }
  run("git", ["init", "--quiet", "--template="])
  const hook = join(root, ".git/hooks/pre-commit")
  assert.equal(existsSync(hook), false)
  run("bun", ["install", "--frozen-lockfile", "--concurrent-scripts=1"])
  assert.equal(existsSync(hook), false, "bun install must not install a pre-commit hook")
  run("bun", ["run", "hooks:install"])
  assert.match(readFileSync(hook, "utf8"), /lefthook/)
})
