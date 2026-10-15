// MOCK/TODO: CI-only synthetic review capture, never a production entry point.
import { fileURLToPath } from 'node:url'
import { runPaymentCapture } from './qui52-runner.mjs'

await runPaymentCapture({
  cwd: fileURLToPath(new URL('..', import.meta.url)),
})
