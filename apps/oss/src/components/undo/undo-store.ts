import { useSyncExternalStore } from "react"

import { UNDO_WINDOW_MS } from "../../lib/undo-window"
import { trpc } from "../../trpc/client"
import { announceRequestDone } from "../command-bar/request-events"
import { refreshReminderJobs } from "../jobs/reminder-jobs-store"

/**
 * One action that can still be taken back. `undo` reverses it; `keepHeld` (server-held sends only)
 * tells the server how long the countdown has left, so a paused countdown does not let the send go;
 * `elapsed` runs when the window closes and may return what to say next.
 */
export type UndoItem = {
  id: string
  kind: "invoice" | "reminders" | "paid"
  /** Reminders: how many go out. */
  count?: number
  endsAt: number
  /** Names the held job, so the corner square can tell its toast has taken over. */
  jobId?: string
  undo: () => Promise<void>
  keepHeld?: (remainingMs: number) => Promise<unknown>
  elapsed?: () => Promise<{ failed: string | null } | void>
}

const listeners = new Set<() => void>()
let items: UndoItem[] = []

function set(next: UndoItem[]) {
  items = next
  for (const listener of listeners) listener()
}

export const addUndo = (item: UndoItem) => set([...items.filter(other => other.id !== item.id), item])
export const removeUndo = (id: string) => set(items.filter(item => item.id !== id))

/** For an action that is already done and has an inverse: the toast offers Fortryd for the window. */
export function showUndo(input: Pick<UndoItem, "kind" | "undo">) {
  addUndo({ ...input, id: crypto.randomUUID(), endsAt: Date.now() + UNDO_WINDOW_MS })
}

type Held = { id: string; type: string; steps: number; heldForMs: number; invoiceId: string | null }

/**
 * Reads the sends the server is still holding and gives each a toast. Called when a send is queued
 * and when the app opens, which is how a held send survives a reload.
 */
export async function syncHeldJobs() {
  let held: Held[]
  try { held = await trpc.jobs.held.query() } catch { return }
  const now = Date.now()
  for (const job of held) {
    if (items.some(item => item.jobId === job.id)) continue
    const invoice = job.invoiceId
    addUndo({
      id: job.id,
      jobId: job.id,
      kind: invoice ? "invoice" : "reminders",
      count: job.steps,
      endsAt: now + job.heldForMs,
      undo: async () => { await trpc.jobs.cancelHeld.mutate({ jobId: job.id }); if (!invoice) await refreshReminderJobs() },
      keepHeld: remainingMs => trpc.jobs.holdHeld.mutate({ jobId: job.id, remainingMs }),
      elapsed: async () => {
        const { status, error } = await trpc.jobs.release.mutate({ jobId: job.id })
        if (!invoice) return void (await refreshReminderJobs())
        if (status === "done") announceRequestDone({ kind: "invoice", invoiceId: invoice })
        return { failed: status === "done" ? null : (error ?? "") }
      },
    })
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

export const useUndoItems = () => useSyncExternalStore(subscribe, () => items, () => [])
