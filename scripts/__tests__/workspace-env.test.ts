import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { discoverWorkspaceEnvFile } = (await import("../workspace-env.js")) as {
  discoverWorkspaceEnvFile: (input?: {
    cwd?: string
    exec?: (
      command: string,
      args: string[],
      options: { cwd: string; encoding: string }
    ) => string
    exists?: (path: string) => boolean
  }) => string | null
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
