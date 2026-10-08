import { afterEach, expect, test, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { READY_PROBE_TIMEOUT_MS, assertNoEnvFiles, testEnvironment, waitForReady } from './harness.mjs'

afterEach(() => vi.unstubAllEnvs())

test('does not pass developer databases, provider credentials or arbitrary Node flags to children', () => {
  vi.stubEnv('DATABASE_URL', 'postgresql://private.invalid/production')
  vi.stubEnv('OSS_DATABASE_URL', 'postgresql://private.invalid/production')
  vi.stubEnv('RESEND_API_KEY', 'real-key')
  vi.stubEnv('SMTP_HOST', 'smtp.private.invalid')
  vi.stubEnv('CLOUDFLARE_API_TOKEN', 'real-token')
  vi.stubEnv('NODE_OPTIONS', '--require /private/bootstrap.cjs')
  const env = testEnvironment()
  expect(env).not.toHaveProperty('DATABASE_URL')
  expect(env).not.toHaveProperty('OSS_DATABASE_URL')
  expect(env.RESEND_API_KEY).toBe('')
  expect(env.SMTP_HOST).toBe('')
  expect(env.CLOUDFLARE_API_TOKEN).toBe('')
  expect(env.NODE_OPTIONS).not.toContain('--require')
})

test('preserves toolchain paths and CI while fixing locale and time', () => {
  vi.stubEnv('CI', 'true')
  vi.stubEnv('PLAYWRIGHT_BROWSERS_PATH', '/tmp/browser-cache')
  const env = testEnvironment()
  expect(env.PATH).toBe(process.env.PATH)
  expect(env.CI).toBe('true')
  expect(env.PLAYWRIGHT_BROWSERS_PATH).toBe('/tmp/browser-cache')
  expect(env.TZ).toBe('UTC')
})

test('rejects active env files before a build without rejecting example files', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'quits-e2e-env-'))
  try {
    writeFileSync(path.join(directory, '.env.example'), 'VITE_EXAMPLE=example')
    expect(() => assertNoEnvFiles([directory])).not.toThrow()
    writeFileSync(path.join(directory, '.env.production.local'), 'VITE_EXAMPLE=developer')
    expect(() => assertNoEnvFiles([directory])).toThrow('clean checkout')
  } finally { rmSync(directory, { recursive: true }) }
})

// Loopback server on a random port. `respond` decides how each request is answered.
async function withServer(respond: http.RequestListener, run: (url: string) => Promise<void>) {
  const server = http.createServer(respond)
  const sockets = new Set<import('node:net').Socket>()
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`) }
  finally {
    for (const socket of sockets) socket.destroy()
    await new Promise(resolve => server.close(resolve))
  }
}

test('waits for a healthy server whose first response takes longer than one second', async () => {
  let requests = 0
  await withServer((_request, response) => {
    // Only the first request is slow, like a first render on a busy host.
    const delay = requests++ === 0 ? 1500 : 0
    setTimeout(() => response.writeHead(200).end('ok'), delay)
  }, async url => {
    await expect(waitForReady(url, { intervalMs: 20 })).resolves.toBeUndefined()
    expect(requests).toBe(1)
  })
})

test('stops at the overall deadline when a probe would outlast it', async () => {
  await withServer(() => { /* Accepts the request and never answers. */ }, async url => {
    const deadlineMs = 700
    const started = performance.now()
    await expect(waitForReady(url, { deadlineMs, probeTimeoutMs: READY_PROBE_TIMEOUT_MS, intervalMs: 50 }))
      .rejects.toThrow(`Timed out after ${deadlineMs}ms`)
    // A 5s probe must be capped by the time remaining instead of extending the deadline.
    expect(performance.now() - started).toBeLessThan(deadlineMs + 500)
  })
})

test('stops waiting when the server process ends', async () => {
  await withServer(() => { /* Never answers. */ }, async url => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 100)
    const started = performance.now()
    await expect(waitForReady(url, { deadlineMs: 10_000, signal: controller.signal })).resolves.toBeUndefined()
    expect(performance.now() - started).toBeLessThan(1000)
  })
})
