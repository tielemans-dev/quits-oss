import { appLogger } from "../lib/observability"
import { runDueJobs } from "./jobs"

const schedulerLogger = appLogger.child("scheduler")

export type TickTask = {
  name: string
  /** Lower runs first. Overdue marking must run before reminders read invoice status. */
  order: number
  run: (now: Date) => Promise<Record<string, number>>
}

const tasks: TickTask[] = [
  { name: "jobs", order: 1000, run: async (now) => runDueJobs({ now }) },
]

export function registerTickTask(task: TickTask) {
  const existing = tasks.findIndex((candidate) => candidate.name === task.name)
  if (existing >= 0) {
    tasks.splice(existing, 1)
  }
  tasks.push(task)
}

/**
 * Runs every scheduled task once. Each task must be idempotent: ticks can overlap or be
 * retried, and a failed task never stops the others.
 */
export async function runSchedulerTick(now = new Date()) {
  const results: Record<string, Record<string, number> | { error: string }> = {}

  for (const task of [...tasks].sort((a, b) => a.order - b.order)) {
    try {
      results[task.name] = await task.run(now)
    } catch (error) {
      results[task.name] = { error: error instanceof Error ? error.message : String(error) }
      schedulerLogger.error("scheduler.task_failed", { task: task.name, error })
    }
  }

  return results
}
