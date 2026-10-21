import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, resolve } from "node:path"

function normalizeGitPath(cwd, value) {
  return resolve(cwd, value.trim())
}

export function discoverWorkspaceEnvFile({
  cwd = process.cwd(),
  exec = execFileSync,
  exists = existsSync,
} = {}) {
  if (process.env.QUITS_WORKTREE_ENV === "1") return null
  let worktreeRoot
  let commonGitDir

  try {
    worktreeRoot = normalizeGitPath(
      cwd,
      exec("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" })
    )
    commonGitDir = normalizeGitPath(
      cwd,
      exec("git", ["rev-parse", "--git-common-dir"], { cwd, encoding: "utf8" })
    )
  } catch {
    return null
  }

  const candidates = [
    resolve(worktreeRoot, ".env"),
    resolve(dirname(commonGitDir), ".env"),
  ]

  for (const candidate of new Set(candidates)) {
    if (exists(candidate)) {
      return candidate
    }
  }

  return null
}

/** True when `envFile` belongs to another checkout, as when a worktree falls back to the main `.env`. */
export function isBorrowedWorkspaceEnvFile(envFile, { cwd = process.cwd(), exec = execFileSync } = {}) {
  try {
    const root = normalizeGitPath(cwd, exec("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" }))
    return dirname(envFile) !== root
  } catch {
    return false
  }
}

export function discoverWorkspaceEnvDir(input) {
  const envFile = discoverWorkspaceEnvFile(input)
  return envFile ? dirname(envFile) : null
}
