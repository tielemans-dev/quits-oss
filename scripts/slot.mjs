import { randomUUID } from "node:crypto"
import { execFileSync } from "node:child_process"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"

export function worktreePaths(cwd = process.cwd()) {
  const git = (flag) => execFileSync("git", ["rev-parse", flag], { cwd, encoding: "utf8" }).trim()
  const root = resolve(cwd, git("--show-toplevel"))
  const common = resolve(cwd, git("--git-common-dir"))
  if (resolve(cwd, git("--git-dir")) === common) throw new Error("Use a linked worktree, not the main checkout")
  return { root, common }
}

// A crashed holder leaves a lock requiring manual recovery. Never steal a live lock.
export async function withRegistry(common, action) {
  const file = resolve(common, "quits-worktree-slots.json")
  const lock = `${file}.lock`
  for (let attempt = 0; ; attempt++) {
    try { await mkdir(lock); break } catch (error) {
      if (error.code !== "EEXIST") throw error
      if (attempt >= 100) throw new Error("Worktree slot lock busy; retry or recover a stopped holder's lock")
      await delay(100)
    }
  }
  const temporary = `${file}.${process.pid}.tmp`
  try {
    let state = { next: 1, allocations: {} }
    try { state = JSON.parse(await readFile(file, "utf8")) } catch (error) {
      if (error.code !== "ENOENT") throw error
    }
    if (!Number.isSafeInteger(state.next) || state.next < 1 || !state.allocations) throw new Error("Invalid slot registry")
    const save = async () => {
      await writeFile(temporary, JSON.stringify(state), { mode: 0o600 })
      await rename(temporary, file)
    }
    return await action(state, save)
  } finally {
    await rm(temporary, { force: true })
    await rm(lock, { recursive: true })
  }
}

export function allocate(state, root) {
  if (!state.allocations[root]) {
    if (state.next > 62435) throw new Error("Worktree port range exhausted")
    state.allocations[root] = { slot: state.next++, created: false, ready: false, owner: randomUUID() }
  }
  const entry = state.allocations[root]
  if (!/^[a-f0-9-]{36}$/.test(entry.owner || "")) throw new Error("Legacy allocation requires manual recovery")
  if (!Number.isSafeInteger(entry.slot) || entry.slot < 1 || entry.slot > 62435 ||
      typeof entry.created !== "boolean" || typeof entry.ready !== "boolean" ||
      (entry.created && typeof entry.target !== "string")) throw new Error("Invalid worktree slot")
  return entry
}

export function databaseEnvironment(entry, source = process.env) {
  let url
  try { url = new URL(source.QUITS_WORKTREE_POSTGRES_URL) } catch {
    throw new Error("Set QUITS_WORKTREE_POSTGRES_URL explicitly to the local development Postgres /postgres database")
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol) ||
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      url.pathname !== "/postgres" || !url.username || url.search || url.hash) {
    throw new Error("Worktree Postgres must use a loopback host, explicit user, /postgres, and no query or fragment")
  }
  const target = `${url.hostname}:${url.port || "5432"}/${url.username}`
  if (entry.target && entry.target !== target) throw new Error("Worktree Postgres target changed; restore the original target")
  const database = `quits_wt_${entry.slot}_${entry.owner?.replaceAll("-", "") || "legacy"}`
  url.pathname = `/${database}`
  // Exclude inherited libpq service/options and passwords from unrelated databases.
  const env = Object.fromEntries(Object.entries(source).filter(([key]) => !key.startsWith("PG")))
  return { target, database, env: {
    ...env, DATABASE_URL: url.href, PORT: String(3100 + entry.slot),
    BETTER_AUTH_URL: `http://localhost:${3100 + entry.slot}`,
    PGHOST: url.hostname === "[::1]" ? "::1" : url.hostname,
    PGPORT: url.port || "5432", PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password), PGPASSFILE: "/dev/null",
    QUITS_WORKTREE_ENV: "1", QUITS_SKIP_PREDEV_BOOTSTRAP: "1",
  } }
}

export async function verifyOwnership(entry, source, execute, cwd) {
  if (!/^[a-f0-9-]{36}$/.test(entry.owner || "")) throw new Error("Legacy allocation has no ownership marker; manual recovery required")
  const { database, env } = databaseEnvironment(entry, source)
  const marker = await execute("psql", ["-X", "--dbname=postgres", "--tuples-only", "--no-align", "--set=ON_ERROR_STOP=1", "--command",
    `SELECT shobj_description(oid, 'pg_database') FROM pg_database WHERE datname = '${database}'`], { cwd, env })
  if (marker !== entry.owner) throw new Error("Database ownership unverified; manual recovery required. No migration or drop permitted")
}

export async function worktreeEnvironment(cwd = process.cwd(), source = process.env, execute = (command, args, options) => {
  try { return execFileSync(command, args, { ...options, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() }
  catch { throw new Error("Database ownership check failed; check local prerequisites") }
}) {
  let paths
  // Ordinary checkouts keep their existing development behavior.
  try { paths = worktreePaths(cwd) } catch (error) {
    if (error.message === "Use a linked worktree, not the main checkout") return null
    throw error
  }
  return withRegistry(paths.common, async (state) => {
    const entry = state.allocations[paths.root]
    if (!entry) throw new Error("Run node scripts/setup-worktree.mjs before starting worktree dev")
    allocate(state, paths.root)
    if (!entry.ready) throw new Error("Worktree setup incomplete; rerun setup-worktree.mjs")
    await verifyOwnership(entry, source, execute, paths.root)
    return databaseEnvironment(entry, source)
  })
}
