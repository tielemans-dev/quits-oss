#!/usr/bin/env node

import dotenv from "dotenv"
import { spawnSync } from "node:child_process"
import { discoverWorkspaceEnvFile } from "./workspace-env.js"
import { worktreeEnvironment } from "./slot.mjs"

const input = process.argv.slice(2)
const dev = input[0] === "--dev"
if (dev) input.shift()
const [command, ...args] = input

if (!command) {
  console.error("Usage: run-with-workspace-env <command> [...args]")
  process.exit(1)
}

const env = { ...process.env }
const worktree = dev ? await worktreeEnvironment() : null
if (worktree) Object.assign(env, worktree.env)
if (worktree) process.env.QUITS_WORKTREE_ENV = "1"
const envFile = discoverWorkspaceEnvFile()

if (envFile) {
  dotenv.config({
    path: envFile,
    processEnv: env,
  })
}

if (dev) {
  // Only the interactive dev command enables background work; direct Vite test servers do not.
  env.QUITS_DEV_SCHEDULER ??= "true"
  const port = env.PORT || "3000"
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error("Invalid PORT")
  args.push("--port", port, "--strictPort")
  let database = "unset"
  try { database = new URL(env.DATABASE_URL).pathname.slice(1) } catch { /* No connection details in logs. */ }
  console.log(`[dev] port=${port} db=${database}`)
}

const result = spawnSync(command, args, {
  stdio: "inherit",
  env,
  shell: process.platform === "win32",
})

if (result.error) {
  throw result.error
}

if (result.signal) {
  process.kill(process.pid, result.signal)
}

process.exit(result.status ?? 1)
