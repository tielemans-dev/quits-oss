/** What a card did once the person confirmed it, for the page behind it to show. */
export type RequestDone = { kind: "invoice"; invoiceId: string }

const listeners = new Set<(done: RequestDone) => void>()

/** Cards know nothing of the page they open over; the page listens for what they finished. */
export function onRequestDone(listener: (done: RequestDone) => void): () => void {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

export function announceRequestDone(done: RequestDone) {
  for (const listener of listeners) listener(done)
}
