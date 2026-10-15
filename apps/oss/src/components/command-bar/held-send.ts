import { useSyncExternalStore } from "react"

/** How long Fortryd can still stop a send after the click. */
export const HOLD_MS = 8000

export type HeldSend = {
  id: number
  customer: string
  amount: string
  /** Epoch ms at which the send starts unless it was undone. */
  deadline: number
  phase: "holding" | "sending" | "failed"
}

let held: readonly HeldSend[] = []
let next = 0
const timers = new Map<number, ReturnType<typeof setTimeout>>()
const listeners = new Set<() => void>()
const set = (value: readonly HeldSend[]) => { held = value; for (const listener of listeners) listener() }
const update = (id: number, change: Partial<HeldSend>) => set(held.map(entry => entry.id === id ? { ...entry, ...change } : entry))

/**
 * A confirmed send waits `HOLD_MS` before anything is made, so Fortryd leaves nothing behind. It is held
 * outside the card, which closes on the click. `run` is the form's create-and-send; it throws if no invoice was made.
 */
export function holdSend(send: { customer: string; amount: string; run: () => Promise<void> }, ms = HOLD_MS) {
  const id = ++next
  set([...held, { id, customer: send.customer, amount: send.amount, deadline: Date.now() + ms, phase: "holding" }])
  timers.set(id, setTimeout(async () => {
    timers.delete(id)
    update(id, { phase: "sending" })
    try {
      await send.run()
      dismissHeldSend(id)
    } catch {
      update(id, { phase: "failed" })
    }
  }, ms))
}

/** Fortryd, or closing a failure: a send already under way cannot be taken back. */
export function dismissHeldSend(id: number) {
  clearTimeout(timers.get(id))
  timers.delete(id)
  set(held.filter(entry => entry.id !== id))
}

export function useHeldSends() {
  return useSyncExternalStore(
    listener => { listeners.add(listener); return () => void listeners.delete(listener) },
    () => held,
    () => held
  )
}
