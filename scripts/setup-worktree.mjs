#!/usr/bin/env node
import { spawnSync } from "node:child_process"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { allocate, databaseEnvironment, withRegistry, worktreePaths } from "./slot.mjs"

export function run(command, args, options) {
  const result = spawnSync(command, args, { ...options, stdio: "pipe" })
  // Database tooling may include credentials in errors. Only report command and exit status.
  if (result.error || result.status !== 0) throw new Error(`${command} failed (${result.status ?? "could not start"}); check local prerequisites`)
}

export async function setup(cwd = process.cwd(), source = process.env, execute = run) {
  const { root, common } = worktreePaths(cwd)
  // Validate prerequisites before allocating a slot or connecting anywhere.
  databaseEnvironment({ slot: 1 }, source)
  return withRegistry(common, async (state, save) => {
    const entry = allocate(state, root)
    const { target, database, env } = databaseEnvironment(entry, source)
    await execute("bun", ["x", "--no-install", "prisma", "--version"], { cwd: resolve(root, "apps/oss"), env })
    entry.target = target
    await save()
    if (!entry.created) {
      await execute("createdb", ["--maintenance-db=postgres", database], { cwd: root, env })
      entry.created = true
      await save()
    }
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
