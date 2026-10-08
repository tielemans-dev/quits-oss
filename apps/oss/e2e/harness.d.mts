export function assertNoEnvFiles(directories: string[]): void
export function testEnvironment(): Record<string, string | undefined>
export function createHarness(options: { cwd: string; logDir: string }): Promise<{
  env: Record<string, string | undefined>
  run(command: string, args: string[], options?: {
    cwd?: string; env?: Record<string, string | undefined>; name?: string
  }): Promise<void>
  serve(command: string, args: string[], url: string, options?: {
    cwd?: string; env?: Record<string, string | undefined>; name?: string
  }): Promise<void>
  close(): Promise<void>
}>
export const READY_DEADLINE_MS: number
export const READY_PROBE_TIMEOUT_MS: number
export function waitForReady(url: string, options?: {
  deadlineMs?: number; probeTimeoutMs?: number; intervalMs?: number; signal?: AbortSignal
}): Promise<void>
