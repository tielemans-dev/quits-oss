import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"

const source = fileURLToPath(new URL("../../", import.meta.url))
const readJson = (path) => JSON.parse(readFileSync(join(source, path), "utf8"))

test("Prisma hooks generate once through root commands, repeated runs and direct app commands", (t) => {
  const temporary = mkdtempSync(join(tmpdir(), "quits-prisma-hooks-"))
  t.after(() => rmSync(temporary, { recursive: true, force: true }))
  const root = join(temporary, "repo")
  const app = join(root, "apps/oss")
  mkdirSync(app, { recursive: true })
  const events = join(temporary, "events")
  const client = join(temporary, "client")
  const recorder = join(temporary, "record.mjs")
  writeFileSync(recorder, `
    import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
    const event = process.argv[2]
    if (event === 'generate') {
      if (process.env.FAIL_GENERATE === '1') process.exit(1)
      writeFileSync(${JSON.stringify(client)}, 'generated')
    } else if (!existsSync(${JSON.stringify(client)})) process.exit(2)
    appendFileSync(${JSON.stringify(events)}, event + '\\n')
  `)
  const manifest = readJson("package.json")
  writeFileSync(join(root, "package.json"), JSON.stringify({
    name: manifest.name, private: true, packageManager: manifest.packageManager,
    workspaces: ["apps/*", "packages/*", "scripts"], scripts: manifest.scripts,
  }))
  const appManifest = readJson("apps/oss/package.json")
  const tasks = ["build", "test", "typecheck", "typecheck:app", "test:integration"]
  const appScripts = { ...appManifest.scripts, "prisma:generate": `node ${recorder} generate` }
  for (const task of tasks) appScripts[task] = `node ${recorder} task`
  writeFileSync(join(app, "package.json"), JSON.stringify({ name: appManifest.name, scripts: appScripts }))
  for (const [path, name] of [["packages/contracts", "contracts"], ["packages/shared", "shared"], ["scripts", "scripts"]]) {
    mkdirSync(join(root, path), { recursive: true })
    writeFileSync(join(root, path, "package.json"), JSON.stringify({ name: `@quits/${name}` }))
  }
  writeFileSync(join(root, "vite.config.ts"), "export default { run: { cache: false } }")
  writeFileSync(join(root, ".gitignore"), "node_modules/\n.vite-plus/\n")
  const env = { ...process.env, PATH: `${join(source, "node_modules/.bin")}${delimiter}${process.env.PATH}` }
  delete env.QUITS_PRISMA_PREGENERATED
  execFileSync("git", ["--no-pager", "init", "--quiet", "--template="], { cwd: root, env })
  execFileSync("git", ["--no-pager", "add", "."], { cwd: root, env })
  const run = (cwd, task, extra = {}) => spawnSync("bun", ["run", task], {
    cwd, env: { ...env, ...extra }, encoding: "utf8", timeout: 30_000,
  })
  for (const cwd of [root, app]) {
    for (const task of tasks) {
      // Repeat root tasks after deleting the client; every invocation must regenerate it.
      for (let attempt = 0; attempt < (cwd === root ? 2 : 1); attempt++) {
        rmSync(client, { force: true })
        writeFileSync(events, "")
        const result = run(cwd, task)
        assert.equal(result.status, 0, `${task}: ${result.error ?? ""}\n${result.stdout}\n${result.stderr}`)
        const recorded = readFileSync(events, "utf8").trim().split("\n")
        assert.equal(recorded.filter((event) => event === "generate").length, 1, `${cwd}/${task}`)
        assert.equal(recorded[0], "generate")
        assert.deepEqual(recorded, ["generate", "task"], task)
      }
    }
    writeFileSync(events, "")
    const failed = run(cwd, "build", { FAIL_GENERATE: "1" })
    assert.notEqual(failed.status, 0)
    assert.equal(readFileSync(events, "utf8"), "", "generation failure must stop the task")
  }
})
