// Targeted, dependency-free verification: node --test scripts/__tests__/check-docs.test.mjs
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const here = dirname(fileURLToPath(import.meta.url))
const script = resolve(here, "../check-docs")
function run(root, ...args) {
  const result = spawnSync(process.execPath, [script, root, ...args], { encoding: "utf8" })
  assert.ifError(result.error)
  return result
}
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "check-docs-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, "docs"))
  return root
}
function content(name) {
  return readFileSync(join(here, "fixtures/check-docs", name), "utf8")
}

test("prose exemptions, CRLF, archives/vendor and symlinks", t => {
  const root = fixture(t)
  writeFileSync(join(root, "AGENTS.md"), content("pass.md").replaceAll("\n", "\r\n"))
  mkdirSync(join(root, "docs/current"))
  writeFileSync(join(root, "docs/current/guide.mdx"), content("pass.md"))
  for (const name of ["releases", "archive", "archives", "archived", "vendor", ".repos"]) {
    mkdirSync(join(root, "docs", name))
    writeFileSync(join(root, "docs", name, "old.md"), content("fail.md"))
  }
  writeFileSync(join(root, "outside.md"), content("fail.md"))
  symlinkSync(join(root, "outside.md"), join(root, "docs/linked.md"))
  symlinkSync(root, join(root, "docs/loop"))
  const result = run(root)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /2 files checked, 0 prose version/)
})

test("findings name the file, original line and version with remediation", t => {
  const root = fixture(t)
  writeFileSync(join(root, "docs/guide.md"), content("fail.md"))
  const result = run(root)
  assert.equal(result.status, 1)
  for (const [line, value] of [[2, "Bun 1.3.9"], [2, "React 19"],
    [3, "1.2.3-beta.1+build.4"], [4, "v2"], [4, "v3.1"], [5, "Prisma 7"],
    [6, "4.5.6"], [7, "React 19"], [11, "PostgreSQL 17"]]) {
    assert.ok(result.stderr.split("\n").some(message =>
      message.startsWith(`docs/guide.md:${line}:`)
      && message.includes(`prose version "${value}"`)), result.stderr)
  }
  assert.match(result.stdout, /9 prose version/)
  assert.match(result.stderr, /reference the manifest/)
})

test("longer fences, mismatched closers and unclosed fences", t => {
  const root = fixture(t)
  writeFileSync(join(root, "AGENTS.md"), "````text\n```\nReact 19\n~~~~\n````\nReact 19\n~~~\nPrisma 7\n")
  const result = run(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /AGENTS.md:6:1:/)
  assert.match(result.stdout, /1 prose version/)
})

test("usage and absent documentation fail instead of reporting clean", t => {
  const root = fixture(t)
  assert.equal(run(root).status, 2)
  assert.equal(run(root, "extra").status, 2)
  assert.equal(run(join(root, "missing")).status, 2)
  const help = spawnSync(process.execPath, [script, "--help"], { encoding: "utf8" })
  assert.ifError(help.error)
  assert.equal(help.status, 0)
  assert.match(help.stdout, /archive/)
})
