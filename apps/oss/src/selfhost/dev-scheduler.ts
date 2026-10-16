/** This module has no startup side effects; only the development server calls it. */
const TICK_DELAY_MS = 5_000
let activeStop: (() => void) | undefined

async function tick() {
  // Register the same tasks and handlers as /api/cron/tick, in the server's runtime.
  await import("../domain/scheduler-tasks")
  const { runSchedulerTick } = await import("../domain/scheduler")
  const results = await runSchedulerTick()
  if (Object.values(results).some(result => "error" in result || (result.failed ?? 0) > 0)) {
    throw new Error("A scheduler task failed")
  }
}

/** Enabled by the dev command, never by an ordinary import, build, or test server. */
export function startDevScheduler(runTick: () => Promise<unknown> = tick) {
  if (process.env.NODE_ENV !== "development" || process.env.QUITS_DEV_SCHEDULER !== "true" ||
    process.env.VITEST || process.env.PLAYWRIGHT_TEST) return () => {}
  if (activeStop) return activeStop

  let stopped = false
  let timer: ReturnType<typeof setTimeout>
  const schedule = () => {
    timer = setTimeout(() => { void run() }, TICK_DELAY_MS)
    timer.unref()
  }
  const run = async () => {
    try {
      await runTick()
    } catch {
      // Scheduler tasks log their own details. Keep configuration and provider text out here.
      console.warn("[dev-scheduler] A tick failed; the scheduler will try again.")
    } finally {
      if (!stopped) schedule()
    }
  }
  const stop = () => {
    stopped = true
    clearTimeout(timer)
    if (activeStop === stop) activeStop = undefined
  }
  activeStop = stop
  schedule()
  return stop
}
