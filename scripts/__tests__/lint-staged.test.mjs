import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { lintStaged } from "../lint-staged.mjs"

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "quits-staged-")))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout
  }
  git("init", "--quiet")
  const write = (name, content = "export const value = 1\n") => writeFileSync(join(root, name), content)
  const capture = join(root, "invocations.jsonl")
  mkdirSync(join(root, "node_modules/.bin"), { recursive: true })
  const binary = join(root, "node_modules/.bin/vp")
  writeFileSync(binary, `#!/usr/bin/env node
const { appendFileSync } = require("node:fs")
appendFileSync(${JSON.stringify(capture)}, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }) + "\\n")
process.exit(0)
`)
  chmodSync(binary, 0o755)
  const calls = () => readFileSync(capture, "utf8").trim().split("\n").map(JSON.parse)
  return { root, git, write, capture, binary, calls }
}

test("passes exact filenames from the index as arguments and runs at the root", (t) => {
  const f = fixture(t)
  const names = ["space name.ts", "quote'\".jsx", "line\nbreak.mjs", "-leading.cts", ":(glob)*.tsx"]
  for (const name of names) f.write(name)
  f.write("untracked.ts")
  f.write("notes.md", "docs")
  f.git("--literal-pathspecs", "add", "--", ...names, "notes.md")
  const indexBefore = f.git("write-tree")
  assert.equal(lintStaged(f.root), 0)
  assert.deepEqual(f.calls(), [{ cwd: f.root, args: [
    "lint", "--deny-warnings", "--report-unused-disable-directives", "--",
    ...names.sort().map((name) => `./${name}`),
  ] }])
  assert.equal(f.git("write-tree"), indexBefore)
})

test("CLI finds the repository root when invoked from a nested directory", (t) => {
  const f = fixture(t)
  mkdirSync(join(f.root, "scripts"))
  const runner = join(f.root, "scripts/lint-staged.mjs")
  writeFileSync(runner, readFileSync(new URL("../lint-staged.mjs", import.meta.url)))
  f.write("source.ts")
  f.git("add", "source.ts")
  const result = spawnSync(process.execPath, [runner], { cwd: join(f.root, "scripts"), encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(f.calls()[0].cwd, f.root)
})

test("skips empty, documentation-only, and deleted-source commits without Vite+", (t) => {
  const f = fixture(t)
  rmSync(f.binary)
  assert.equal(lintStaged(f.root), 0)
  f.write("notes.md", "docs")
  f.write("deleted.ts")
  f.git("add", "notes.md", "deleted.ts")
  f.git("-c", "core.hooksPath=/dev/null", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
    "commit", "--quiet", "-m", "fixture")
  f.git("rm", "deleted.ts")
  f.write("notes.md", "changed docs")
  f.git("add", "notes.md")
  assert.equal(lintStaged(f.root), 0)
})

test("rejects partial staging without changing the index or working copy", (t) => {
  const f = fixture(t)
  f.write("partial.ts", "staged\n")
  f.git("add", "partial.ts")
  f.write("partial.ts", "unstaged\n")
  const indexBefore = f.git("write-tree")
  assert.throws(() => lintStaged(f.root), /Partial staging is not supported/)
  assert.equal(f.git("write-tree"), indexBefore)
  assert.equal(readFileSync(join(f.root, "partial.ts"), "utf8"), "unstaged\n")
  assert.equal(f.git("show", ":partial.ts"), "staged\n")
})

test("rejects source symlinks and unstaged deletions before invoking Vite+", (t) => {
  const f = fixture(t)
  f.write("target.txt")
  symlinkSync("target.txt", join(f.root, "linked.ts"))
  f.git("add", "linked.ts")
  assert.throws(() => lintStaged(f.root), /must be a regular file/)
  f.git("rm", "--cached", "linked.ts")
  f.write("missing.ts")
  f.git("add", "missing.ts")
  rmSync(join(f.root, "missing.ts"))
  assert.throws(() => lintStaged(f.root), /Partial staging is not supported/)
})

test("preserves a lint failure and reports a missing binary without fetching", (t) => {
  const f = fixture(t)
  f.write("source.ts")
  f.git("add", "source.ts")
  writeFileSync(f.binary, "#!/usr/bin/env node\nprocess.exit(7)\n")
  assert.equal(lintStaged(f.root), 7)
  rmSync(f.binary)
  assert.throws(() => lintStaged(f.root), /Local Vite\+ could not start/)
})

test("installed Lefthook rejects partial staging without hiding or staging changes", (t) => {
  const f = fixture(t)
  const lefthook = new URL("../../node_modules/.bin/lefthook", import.meta.url).pathname
  symlinkSync(lefthook, join(f.root, "node_modules/.bin/lefthook"))
  mkdirSync(join(f.root, "scripts"))
  for (const name of ["lint-staged.mjs", "lefthook.sh"]) {
    writeFileSync(join(f.root, "scripts", name), readFileSync(new URL(`../${name}`, import.meta.url)))
  }
  writeFileSync(join(f.root, "lefthook.yml"), readFileSync(new URL("../../lefthook.yml", import.meta.url)))
  f.write("package.json", JSON.stringify({ scripts: { "lint:staged": "bun scripts/lint-staged.mjs" } }))
  const installed = spawnSync(lefthook, ["install"], { cwd: f.root, encoding: "utf8" })
  assert.equal(installed.status, 0, installed.stderr)
  f.write("partial.ts", "staged\n")
  f.git("add", "partial.ts")
  f.write("partial.ts", "unstaged\n")
  const indexBefore = f.git("write-tree")
  const commit = spawnSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
    "commit", "-m", "fixture partial staging"], { cwd: f.root, encoding: "utf8" })
  assert.notEqual(commit.status, 0)
  assert.match(commit.stdout + commit.stderr, /Partial staging is not supported/)
  assert.equal(f.git("write-tree"), indexBefore)
  assert.equal(readFileSync(join(f.root, "partial.ts"), "utf8"), "unstaged\n")
})
