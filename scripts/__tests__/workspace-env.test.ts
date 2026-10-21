import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { discoverWorkspaceEnvFile, isBorrowedWorkspaceEnvFile } = (await import("../workspace-env.js")) as {
  discoverWorkspaceEnvFile: (input?: {
    cwd?: string
    exec?: (
      command: string,
      args: string[],
      options: { cwd: string; encoding: string }
    ) => string
    exists?: (path: string) => boolean
  }) => string | null
  isBorrowedWorkspaceEnvFile: (envFile: string, input?: { cwd?: string; exec?: () => string }) => boolean
}

describe("discoverWorkspaceEnvFile", () => {
  beforeEach(() => vi.stubEnv("QUITS_WORKTREE_ENV", ""))
  afterEach(() => vi.unstubAllEnvs())
  it("prefers the current worktree root .env", () => {
    const envFile = discoverWorkspaceEnvFile({
      cwd: "/repo/.worktrees/feature/apps/oss",
      exec(_command, args) {
        return args[1] === "--show-toplevel"
          ? "/repo/.worktrees/feature\n"
          : "/repo/.git\n"
      },
      exists(path) {
        return path === "/repo/.worktrees/feature/.env"
      },
    })

    expect(envFile).toBe("/repo/.worktrees/feature/.env")
  })

  it("falls back to the shared repo root .env when the worktree has none", () => {
    const envFile = discoverWorkspaceEnvFile({
      cwd: "/repo/.worktrees/feature/apps/oss",
      exec(_command, args) {
        return args[1] === "--show-toplevel"
          ? "/repo/.worktrees/feature\n"
          : "/repo/.git\n"
      },
      exists(path) {
        return path === "/repo/.env"
      },
    })

    expect(envFile).toBe("/repo/.env")
  })

  it("returns null when no supported .env file exists", () => {
    const envFile = discoverWorkspaceEnvFile({
      cwd: "/repo/.worktrees/feature/apps/oss",
      exec(_command, args) {
        return args[1] === "--show-toplevel"
          ? "/repo/.worktrees/feature\n"
          : "/repo/.git\n"
      },
      exists() {
        return false
      },
    })

    expect(envFile).toBeNull()
  })
})

describe("isBorrowedWorkspaceEnvFile", () => {
  const worktree = { cwd: "/repo/.worktrees/feature/apps/oss", exec: () => "/repo/.worktrees/feature\n" }

  it("flags the main checkout's .env when used from a worktree", () => {
    expect(isBorrowedWorkspaceEnvFile("/repo/.env", worktree)).toBe(true)
  })

  it("accepts the checkout's own .env", () => {
    expect(isBorrowedWorkspaceEnvFile("/repo/.worktrees/feature/.env", worktree)).toBe(false)
    expect(isBorrowedWorkspaceEnvFile("/repo/.env", { cwd: "/repo/apps/oss", exec: () => "/repo\n" })).toBe(false)
  })
})
