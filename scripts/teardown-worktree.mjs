#!/usr/bin/env node
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { allocate, databaseEnvironment, withRegistry, worktreePaths } from "./slot.mjs"
import { run } from "./setup-worktree.mjs"

export async function teardown(cwd = process.cwd(), source = process.env, execute = run) {
  const { root, common } = worktreePaths(cwd)
  return withRegistry(common, async (state, save) => {
    const entry = state.allocations[root]
    if (!entry) return
    allocate(state, root)
    const { database, env } = databaseEnvironment(entry, source)
    if (entry.created) await execute("dropdb", ["--maintenance-db=postgres", "--if-exists", database], { cwd: root, env })
    delete state.allocations[root]
    await save()
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  teardown().catch((error) => { console.error(error.message); process.exitCode = 1 })
}
