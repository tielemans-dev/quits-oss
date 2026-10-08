import { spawn, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, openSync, closeSync, rmSync, existsSync } from 'node:fs'
import path from 'node:path'
import net from 'node:net'

// Only operating-system/toolchain settings cross into the disposable environment.
export function testEnvironment() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(PATH|HOME|USER|TMPDIR|TMP|TEMP|SHELL|CI|SYSTEMROOT|PLAYWRIGHT_BROWSERS_PATH|NODE_EXTRA_CA_CERTS)$/.test(key)))
  return { ...env, NODE_OPTIONS: '--max-old-space-size=6144', NO_COLOR: '1', TZ: 'UTC', RESEND_API_KEY: '', SMTP_HOST: '',
    STRIPE_SECRET_KEY: '', OPENROUTER_API_KEY: '', WRANGLER_SEND_METRICS: 'false',
    CLOUDFLARE_API_TOKEN: '', CLOUDFLARE_ACCOUNT_ID: '' }
}

/** Fail before Vite/dotenv can merge checkout-local settings into a test build. */
export function assertNoEnvFiles(directories) {
  for (const directory of new Set(directories)) {
    for (const name of ['.env', '.env.local', '.env.production', '.env.production.local', '.dev.vars']) {
      if (existsSync(path.join(directory, name))) {
        throw new Error(`Browser E2E requires a clean checkout without ${path.join(directory, name)}. Use a separate checkout; no env files were changed.`)
      }
    }
  }
}

/** Owns only the container and child processes it creates. Never uses DATABASE_URL from the caller. */
export async function createHarness({ cwd, logDir }) {
  rmSync(logDir, { recursive: true, force: true })
  mkdirSync(logDir, { recursive: true })
  const env = testEnvironment()
  const children = []
  const servers = []
  const container = `quits-e2e-${randomUUID()}`
  let containerCreated = false
  let closed = false
  async function close() {
    if (closed) return
    closed = true
    for (const child of children.reverse()) {
      try { process.kill(-child.pid, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') throw error }
    }
    await new Promise(resolve => setTimeout(resolve, 300))
    for (const child of children) {
      try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
    }
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', interrupt)
    if (containerCreated) {
      try { execFileSync('docker', ['rm', '-f', container], { stdio: 'ignore' }) }
      catch (error) { console.error(`Could not remove disposable container ${container}: ${error.message}`); process.exitCode = 1 }
    }
  }
  const interrupt = () => { void close().finally(() => process.exit(130)) }
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', interrupt)
  function launch(command, args, options = {}) {
    const fd = openSync(path.join(logDir, `${options.name ?? command}.log`), 'a')
    const child = spawn(command, args, {
      cwd: options.cwd ?? cwd, env: { ...env, ...options.env },
      detached: true, stdio: ['ignore', fd, fd],
    })
    closeSync(fd)
    const done = new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${command} exited ${code ?? signal}; see ${logDir}`)))
    })
    // Server completion is checked during readiness and when tests finish.
    done.catch(() => {})
    if (child.pid) children.push(child)
    return { child, done }
  }
  async function run(command, args, options) {
    await Promise.race([launch(command, args, options).done, ...servers])
  }
  async function serve(command, args, url, options) {
    const target = new URL(url)
    await new Promise((resolve, reject) => {
      const probe = net.createServer()
      probe.once('error', reject)
      probe.listen(Number(target.port), target.hostname, () => probe.close(resolve))
    })
    const launched = launch(command, args, options)
    const stopped = launched.done.then(() => { throw new Error(`${command} server stopped`) })
    stopped.catch(() => {})
    servers.push(stopped)
    let finished = false
    const ready = async () => {
      for (let attempt = 0; attempt < 120 && !finished; attempt++) {
        try {
          const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(1000) })
          if (response.status >= 200 && response.status < 400) return
        } catch { /* Not listening yet. */ }
        await new Promise(resolve => setTimeout(resolve, 500))
      }
      throw new Error(`Timed out waiting for ${url}; see ${logDir}`)
    }
    try { await Promise.race([ready(), stopped]) } finally { finished = true }
  }
  try {
    execFileSync('docker', ['run', '--detach', '--rm', '--name', container,
      '-e', 'POSTGRES_USER=postgres', '-e', 'POSTGRES_PASSWORD=postgres', '-e', 'POSTGRES_DB=quits_e2e',
      '-p', '127.0.0.1::5432', 'postgres:16-alpine'], { stdio: 'pipe' })
    containerCreated = true
    const address = execFileSync('docker', ['port', container, '5432/tcp'], { encoding: 'utf8' }).trim()
    env.DATABASE_URL = `postgresql://postgres:postgres@${address}/quits_e2e`
    env.OSS_DATABASE_URL = env.DATABASE_URL
    let ready = false
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        execFileSync('docker', ['exec', container, 'pg_isready', '-U', 'postgres', '-d', 'quits_e2e'], { stdio: 'ignore' })
        ready = true
        break
      } catch { await new Promise(resolve => setTimeout(resolve, 500)) }
    }
    if (!ready) throw new Error('Disposable PostgreSQL failed to start')
  } catch (error) { await close(); throw error }
  return { env, run, serve, close }
}
