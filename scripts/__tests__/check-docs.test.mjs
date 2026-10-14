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
    [6, "4.5.6"], [7, "React 19"], [11, "PostgreSQL 17"],
    [12, "Bun 1.3.9"], [16, "Bun 1.3.9"], [17, "Bun 1.3.9"],
    [20, "Bun 1.3.9"], [23, "Bun 1.3.9"], [25, "Bun 1.3.9"],
    [26, "Bun 1.3.9"], [27, "Bun>=1.3"], [27, "Bun≥1.3"],
    [27, "Bun >= 1.3"], [28, "React 19"], [29, "Bun 1.3.9"]]) {
    assert.ok(result.stderr.split("\n").some(message =>
      message.startsWith(`docs/guide.md:${line}:`)
      && message.includes(`prose version "${value}"`)), result.stderr)
  }
  assert.match(result.stdout, /21 prose version/)
  assert.match(result.stderr, /reference the manifest/)
})

test("regression fixtures preserve exact columns with LF and CRLF", t => {
  const root = fixture(t)
  const source = content("fail.md")
  const expected = [[12, "Bun 1.3.9"], [16, "Bun 1.3.9"], [17, "Bun 1.3.9"],
    [20, "Bun 1.3.9"], [23, "Bun 1.3.9"], [25, "Bun 1.3.9"],
    [26, "Bun 1.3.9"], [27, "Bun>=1.3"], [27, "Bun≥1.3"],
    [27, "Bun >= 1.3"], [28, "React 19"], [29, "Bun 1.3.9"]]
  for (const newline of ["\n", "\r\n"]) {
    writeFileSync(join(root, "AGENTS.md"), source.replaceAll("\n", newline))
    const result = run(root)
    assert.equal(result.status, 1)
    for (const [line, value] of expected) {
      const column = source.split("\n")[line - 1].indexOf(value) + 1
      assert.ok(result.stderr.includes(`AGENTS.md:${line}:${column}: prose version "${value}"`), result.stderr)
    }
  }
})

test("each reported false negative fails independently", t => {
  const root = fixture(t)
  const lines = content("fail.md").split("\n")
  for (const [first, last, count] of [[12, 12, 1], [13, 16, 1], [17, 17, 1],
    [18, 20, 1], [22, 23, 1], [24, 25, 1], [26, 26, 1], [27, 27, 3], [28, 28, 1]]) {
    writeFileSync(join(root, "AGENTS.md"), lines.slice(first - 1, last).join("\n"))
    const result = run(root)
    assert.equal(result.status, 1, `fixture lines ${first}-${last}: ${result.stderr}`)
    assert.match(result.stdout, new RegExp(`${count} prose version`))
  }
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
