import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { allocate, databaseEnvironment, withRegistry, worktreeEnvironment, worktreePaths } from "../slot.mjs"
import { discoverWorkspaceEnvFile } from "../workspace-env.js"
import { setup } from "../setup-worktree.mjs"
import { teardown } from "../teardown-worktree.mjs"

const source = { QUITS_WORKTREE_POSTGRES_URL: "postgresql://fixture:fixture@localhost:5432/postgres", PGOPTIONS: "unsafe", DATABASE_URL: "postgresql://production.invalid/live" }

test("database guard rejects remote, inherited, malformed, and ambiguous targets", () => {
  for (const value of [undefined, source.DATABASE_URL, "mysql://fixture@localhost/postgres", "postgresql://fixture@localhost/live", "postgresql://fixture@localhost/postgres?host=production.invalid", "postgresql://localhost/postgres"]) {
    assert.throws(() => databaseEnvironment({ slot: 1 }, { QUITS_WORKTREE_POSTGRES_URL: value }))
  }
  const { env, database } = databaseEnvironment({ slot: 7 }, source)
  assert.equal(env.DATABASE_URL, "postgresql://fixture:fixture@localhost:5432/quits_wt_7")
  assert.equal(database, "quits_wt_7")
  assert.equal(env.PORT, "3107")
  assert.equal(env.BETTER_AUTH_URL, "http://localhost:3107")
  assert.equal(env.PGOPTIONS, undefined)
  assert.equal(env.PGPASSFILE, "/dev/null")
  assert.throws(() => databaseEnvironment({ slot: 1, target: "other" }, source))
})

test("independent processes allocate unique slots and release without resetting the counter", async () => {
  const common = await mkdtemp(join(tmpdir(), "quits-slots-"))
  try {
    const module = new URL("../slot.mjs", import.meta.url).href
    await Promise.all(Array.from({ length: 8 }, (_, index) => new Promise((done, reject) => {
      const code = `import {withRegistry,allocate} from ${JSON.stringify(module)}; await withRegistry(process.argv[1], async(s,save)=>{allocate(s,process.argv[2]);await save()})`
      const child = spawn(process.execPath, ["--input-type=module", "-e", code, common, `/wt/${index}`], { stdio: "ignore" })
      child.on("error", reject)
      child.on("exit", (status) => status === 0 ? done() : reject(new Error(`child ${status}`)))
    })))
    await withRegistry(common, async (state, save) => {
      assert.equal(new Set(Object.values(state.allocations).map((entry) => entry.slot)).size, 8)
      const slot = allocate(state, "/wt/0").slot
      assert.equal(allocate(state, "/wt/0").slot, slot)
      delete state.allocations["/wt/0"]
      assert.equal(allocate(state, "/wt/new").slot, 9)
      await save()
    })
    await assert.rejects(withRegistry(common, () => { throw new Error("failure") }), /failure/)
    await withRegistry(common, () => {})
    await writeFile(join(common, "quits-worktree-slots.json"), "broken")
    await assert.rejects(withRegistry(common, () => {}), SyntaxError)
  } finally { await rm(common, { recursive: true, force: true }) }
})

test("setup and teardown only operate on a recorded worktree DB, preserve failed cleanup, and retry migrations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quits-setup-"))
  const main = join(directory, "main"), worktree = join(directory, "worktree")
  const git = (...args) => execFileSync("git", args, { cwd: main, stdio: "ignore" })
  try {
    await mkdir(main)
    git("init")
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-m", "fixture")
    git("worktree", "add", "-b", "fixture", worktree)
    assert.throws(() => worktreePaths(main), /linked worktree/)
    const common = worktreePaths(worktree).common
    const read = async () => JSON.parse(await readFile(join(common, "quits-worktree-slots.json"), "utf8"))
    await assert.rejects(setup(worktree, source, () => { throw new Error("missing Prisma") }), /missing Prisma/)
    await assert.rejects(read(), { code: "ENOENT" })
    const calls = []
    const execute = (command, args, options) => {
      calls.push([command, args, options.env.DATABASE_URL])
      assert.equal(options.env.QUITS_WORKTREE_ENV, "1")
      assert.match(options.env.DATABASE_URL, /\/quits_wt_1$/)
    }
    await assert.rejects(setup(worktree, {}, execute), /Set QUITS_WORKTREE_POSTGRES_URL/)
    await assert.rejects(setup(worktree, source, (command, ...rest) => {
      execute(command, ...rest)
      if (command === "createdb") throw new Error("already exists")
    }), /already exists/)
    assert.equal((await read()).allocations[worktree].created, false)
    assert.equal(calls.filter(([command]) => command === "createdb").length, 1)
    await assert.rejects(setup(worktree, source, (command, ...rest) => {
      execute(command, ...rest)
      if (command === "bun" && rest[0].includes("migrate")) throw new Error("migration failed")
    }), /migration failed/)
    assert.equal((await read()).allocations[worktree].ready, false)
    await assert.rejects(worktreeEnvironment(worktree, source), /setup incomplete/)
    await setup(worktree, source, execute)
    assert.equal(calls.filter(([command]) => command === "createdb").length, 2)
    assert.equal((await read()).allocations[worktree].ready, true)
    assert.equal((await worktreeEnvironment(worktree, source)).env.PORT, "3101")
    const previous = process.env.QUITS_WORKTREE_ENV
    process.env.QUITS_WORKTREE_ENV = "1"
    try {
      assert.equal(discoverWorkspaceEnvFile({ exec: () => assert.fail("must not discover .env"), exists: () => assert.fail("must not inspect .env") }), null)
    } finally {
      if (previous === undefined) delete process.env.QUITS_WORKTREE_ENV
      else process.env.QUITS_WORKTREE_ENV = previous
    }
    await assert.rejects(teardown(worktree, source, () => { throw new Error("DB busy") }), /DB busy/)
    assert.equal((await read()).allocations[worktree].created, true)
    await teardown(worktree, source, execute)
    assert.deepEqual(calls.at(-1).slice(0, 2), ["dropdb", ["--maintenance-db=postgres", "--if-exists", "quits_wt_1"]])
    assert.equal((await read()).allocations[worktree], undefined)
    await teardown(worktree, source, () => assert.fail("idempotent teardown"))
  } finally { await rm(directory, { recursive: true, force: true }) }
})
