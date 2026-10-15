import { useEffect, useRef, useState, type CSSProperties } from "react"

import { StatusBadge } from "../status-badge"

/** Delay between rows whose pill changes together. */
export const PILL_STAGGER_MS = 90
const PILL_SWAP_MS = 300

/**
 * An invoice status pill that crossfades when its status changes (Overdue → Reminder sent) and
 * draws plainly otherwise, so a page that loads with the status already set does not animate.
 * `delay` staggers rows that change together; reduced motion cuts the delay and keeps the fade.
 */
export function SwappingStatusBadge({ status, delay = 0 }: { status: string; delay?: number }) {
  const previous = useRef(status)
  const [outgoing, setOutgoing] = useState<string | null>(null)

  useEffect(() => {
    if (previous.current === status) return
    setOutgoing(previous.current)
    previous.current = status
    const timer = setTimeout(() => setOutgoing(null), PILL_SWAP_MS + delay)
    return () => clearTimeout(timer)
  }, [status, delay])

  const style = { "--stagger": `${delay}ms` } as CSSProperties
  return (
    <span className="inline-grid" style={style}>
      {outgoing ? (
        <span aria-hidden className="pill-out col-start-1 row-start-1">
          <StatusBadge domain="invoice" status={outgoing} />
        </span>
      ) : null}
      <span key={status} className={outgoing ? "pill-in col-start-1 row-start-1" : "col-start-1 row-start-1"}>
        <StatusBadge domain="invoice" status={status} />
      </span>
    </span>
  )
}
