import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
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
  assert.equal(env.DATABASE_URL, "postgresql://fixture:fixture@localhost:5432/quits_wt_7_legacy")
  assert.equal(database, "quits_wt_7_legacy")
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
      assert.equal(new Set(Object.values(state.allocations).map((entry) => entry.owner)).size, 8)
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
  const directory = await realpath(await mkdtemp(join(tmpdir(), "quits-setup-")))
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
    let marker = ""
    const execute = (command, args, options) => {
      calls.push([command, args, options.env.DATABASE_URL])
      assert.equal(options.env.QUITS_WORKTREE_ENV, "1")
      assert.match(options.env.DATABASE_URL, /\/quits_wt_\d+_[a-f0-9]{32}$/)
      if (command === "psql" && args.at(-1).startsWith("COMMENT")) marker = args.at(-1).split("'")[1]
      return command === "psql" ? marker : undefined
    }
    await assert.rejects(setup(worktree, {}, execute), /Set QUITS_WORKTREE_POSTGRES_URL/)
    // A crash after createdb but before its marker must never adopt or drop that DB.
    await assert.rejects(setup(worktree, source, (command, ...rest) => {
      if (command === "psql" && rest[0].at(-1).startsWith("COMMENT")) throw new Error("crash before marker")
      return execute(command, ...rest)
    }), /crash before marker/)
    assert.equal((await read()).allocations[worktree].created, false)
    for (const operation of [setup, teardown]) await assert.rejects(operation(worktree, source, execute), /ownership unverified/)
    assert.equal(calls.filter(([command, args]) => command === "createdb" && args[0] !== "--version").length, 1)
    assert.equal(calls.filter(([command, args]) => (command === "dropdb" && args[0] !== "--version") || args.includes("migrate")).length, 0)
    // A persisted matching marker recovers a crash before the ownership flag save.
    marker = (await read()).allocations[worktree].owner
    const beforeGeneration = calls.length
    await assert.rejects(setup(worktree, source, (command, args, options) => {
      if (command === "bun" && args.includes("generate")) {
        assert.equal(options.cwd, join(worktree, "apps/oss"))
        throw new Error("generation failed")
      }
      return execute(command, args, options)
    }), /generation failed/)
    assert.equal((await read()).allocations[worktree].ready, false)
    assert.equal(calls.slice(beforeGeneration).some(([, args]) => args.includes("migrate")), false)
    await assert.rejects(setup(worktree, source, (command, ...rest) => {
      const output = execute(command, ...rest)
      if (command === "bun" && rest[0].includes("migrate")) throw new Error("migration failed")
      return output
    }), /migration failed/)
    assert.equal((await read()).allocations[worktree].ready, false)
    await assert.rejects(worktreeEnvironment(worktree, source), /setup incomplete/)
    const beforeRetry = calls.length
    await setup(worktree, source, execute)
    assert.deepEqual(calls.slice(beforeRetry).filter(([command]) => command === "bun").map(([, args]) => args), [
      ["x", "--no-install", "prisma", "--version"],
      ["x", "--no-install", "prisma", "generate"],
      ["x", "--no-install", "prisma", "migrate", "deploy"],
    ])
    assert.equal(calls.filter(([command, args]) => command === "createdb" && args[0] !== "--version").length, 1)
    assert.equal((await read()).allocations[worktree].ready, true)
    assert.equal((await worktreeEnvironment(worktree, source, execute)).env.PORT, "3101")
    const previous = process.env.QUITS_WORKTREE_ENV
    process.env.QUITS_WORKTREE_ENV = "1"
    try {
      assert.equal(discoverWorkspaceEnvFile({ exec: () => assert.fail("must not discover .env"), exists: () => assert.fail("must not inspect .env") }), null)
    } finally {
      if (previous === undefined) delete process.env.QUITS_WORKTREE_ENV
      else process.env.QUITS_WORKTREE_ENV = previous
    }
    marker = "unowned replacement"
    for (const operation of [setup, teardown, worktreeEnvironment]) await assert.rejects(operation(worktree, source, execute), /ownership unverified/)
    marker = (await read()).allocations[worktree].owner
    await assert.rejects(teardown(worktree, source, (command, ...rest) => {
      if (command === "dropdb") throw new Error("DB busy")
      return execute(command, ...rest)
    }), /DB busy/)
    assert.equal((await read()).allocations[worktree].created, true)
    await teardown(worktree, source, execute)
    assert.deepEqual(calls.at(-1).slice(0, 2), ["dropdb", ["--maintenance-db=postgres", "--if-exists", new URL(calls.at(-1)[2]).pathname.slice(1)]])
    assert.equal((await read()).allocations[worktree], undefined)
    await teardown(worktree, source, () => assert.fail("idempotent teardown"))
    // Execute the real marker-writing path, then lose the ownership flag save.
    await assert.rejects(setup(worktree, source, (command, ...rest) => {
      if (command === "psql" && rest[0].at(-1).startsWith("SELECT")) throw new Error("crash after marker")
      return execute(command, ...rest)
    }), /crash after marker/)
    assert.equal((await read()).allocations[worktree].created, false)
    await setup(worktree, source, execute)
    await teardown(worktree, source, execute)
    marker = "preexisting unowned DB"
    const before = calls.length
    await assert.rejects(setup(worktree, source, (command, ...rest) => {
      if (command === "createdb" && rest[0][0] !== "--version") throw new Error("already exists")
      return execute(command, ...rest)
    }), /already exists/)
    for (const operation of [setup, teardown]) await assert.rejects(operation(worktree, source, execute), /ownership unverified/)
    assert.equal(calls.slice(before).some(([command, args]) => args.at(-1).startsWith("COMMENT") || (command === "dropdb" && args[0] !== "--version") || args.includes("migrate")), false)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
