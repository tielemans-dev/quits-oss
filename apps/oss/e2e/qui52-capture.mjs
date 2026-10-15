// MOCK/TODO: CI-only synthetic review capture, never a production entry point.
import { fileURLToPath } from 'node:url'
import { runPaymentCapture } from './qui52-runner.mjs'

await runPaymentCapture({
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  baseline: '4931661dd7e53d83555590e06a2e2cf97448743b',
})
