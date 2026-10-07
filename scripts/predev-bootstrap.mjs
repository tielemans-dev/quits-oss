#!/usr/bin/env node

import dotenv from "dotenv"
import { spawnSync } from "node:child_process"
import { resolveDatabaseTarget } from "./predev-bootstrap-lib.mjs"
import { discoverWorkspaceEnvFile } from "./workspace-env.js"

const envFile = discoverWorkspaceEnvFile()
if (envFile) {
  dotenv.config({ path: envFile })
}

function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: process.env,
  })

  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

if ((process.env.QUITS_SKIP_PREDEV_BOOTSTRAP ?? process.env.YAIP_SKIP_PREDEV_BOOTSTRAP) === "1") {
  process.exit(0)
}

const target = resolveDatabaseTarget(process.env.DATABASE_URL)
const bunCommand = process.platform === "win32" ? "bun.exe" : "bun"

if (target.kind === "missing") {
  console.error("DATABASE_URL is required. Set it in .env before running bun dev.")
  process.exit(1)
}

if (target.kind === "invalid") {
  console.error("DATABASE_URL is invalid. Update it in .env before running bun dev.")
  process.exit(1)
}

if (target.kind === "local") {
  console.log(`Detected local DATABASE_URL host (${target.host}). Starting local Postgres...`)
  run(bunCommand, ["run", "db:start"])
}

console.log("Applying Prisma migrations...")
run(bunCommand, ["x", "prisma", "migrate", "deploy"])
