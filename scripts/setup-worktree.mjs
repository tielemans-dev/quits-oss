#!/usr/bin/env node
import { spawnSync } from "node:child_process"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { allocate, databaseEnvironment, verifyOwnership, withRegistry, worktreePaths } from "./slot.mjs"

export function run(command, args, options) {
  const result = spawnSync(command, args, { ...options, stdio: "pipe" })
  // Database tooling may include credentials in errors. Only report command and exit status.
  if (result.error || result.status !== 0) throw new Error(`${command} failed (${result.status ?? "could not start"}); check local prerequisites`)
  return result.stdout.toString().trim()
}

export async function setup(cwd = process.cwd(), source = process.env, execute = run) {
  const { root, common } = worktreePaths(cwd)
  // Validate prerequisites before allocating a slot or connecting anywhere.
  databaseEnvironment({ slot: 1 }, source)
  return withRegistry(common, async (state, save) => {
    const entry = allocate(state, root)
    const { target, database, env } = databaseEnvironment(entry, source)
    await execute("bun", ["x", "--no-install", "prisma", "--version"], { cwd: resolve(root, "apps/oss"), env })
    for (const command of ["psql", "createdb", "dropdb"]) await execute(command, ["--version"], { cwd: root, env })
    entry.target = target
    await save()
    if (entry.created && !entry.attempted) throw new Error("Legacy allocation requires manual recovery")
    if (entry.attempted) await verifyOwnership(entry, source, execute, root)
    else {
      entry.attempted = true
      await save()
      await execute("createdb", ["--maintenance-db=postgres", database], { cwd: root, env })
      await execute("psql", ["-X", "--dbname=postgres", "--set=ON_ERROR_STOP=1", "--command",
        `COMMENT ON DATABASE "${database}" IS '${entry.owner}'`], { cwd: root, env })
      await verifyOwnership(entry, source, execute, root)
    }
    entry.created = true
    await save()
    entry.ready = false
    await save()
    await execute("bun", ["x", "--no-install", "prisma", "migrate", "deploy"], { cwd: resolve(root, "apps/oss"), env })
    entry.ready = true
    await save()
    console.log(`[worktree] port=${env.PORT} db=${database}`)
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  setup().catch((error) => { console.error(error.message); process.exitCode = 1 })
}
