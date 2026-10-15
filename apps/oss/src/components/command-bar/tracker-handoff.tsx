import { Loader2, X } from "lucide-react"
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { createRoot } from "react-dom/client"

import { DURATION, EASE_ENTER } from "../../lib/motion"
import { cn } from "../../lib/utils"
import { holdTracker } from "../jobs/tracker-hold"
import { Button } from "../ui/button"

/** The square the tracker toast grows out of, in the corner (see `tracker-morph` in styles.css). */
const SQUARE = 176
const MARGIN = 16
const SHRINK_MS = DURATION.squareShrink
const FLY_MS = DURATION.squareFly
/** Once the job is queued, the square waits this long for the toast before it lets go anyway. */
const SETTLE_MS = 1500
const TOAST = '[data-slot="reminder-tracker"], [data-slot="undo-toast"][data-job-id]'

export type HandoffLabels = { failed: string; retry: string; close: string }

const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false

function fly(el: HTMLElement, from: DOMRect, done: () => void) {
  const corner = { left: window.innerWidth - MARGIN - SQUARE, top: window.innerHeight - MARGIN - SQUARE }
  const box = (left: number, top: number, size: { width: number; height: number }, radius: number) =>
    ({ left: `${left}px`, top: `${top}px`, width: `${size.width}px`, height: `${size.height}px`, borderRadius: `${radius}px`, easing: EASE_ENTER })
  const square = { width: SQUARE, height: SQUARE }
  if (typeof el.animate !== "function") return done()
  // Reduced motion: no travel, the square only fades in where it ends.
  const animation = reducedMotion()
    ? el.animate({ opacity: [0, 1] }, { duration: DURATION.fade })
    : el.animate(
        [
          box(from.left, from.top, from, 18),
          { ...box(from.left + (from.width - SQUARE) / 2, from.top + (from.height - SQUARE) / 2, square, 16), offset: SHRINK_MS / (SHRINK_MS + FLY_MS) },
          box(corner.left, corner.top, square, 16),
        ],
        { duration: SHRINK_MS + FLY_MS }
      )
  animation.finished.then(done, done)
}

function Square({ from, send, labels, release }: { from: DOMRect; send: () => Promise<unknown>; labels: HandoffLabels; release: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [failed, setFailed] = useState(false)
  const [queued, setQueued] = useState(false)
  const [landed, setLanded] = useState(false)
  // The toast that was already there is not the one this square waits for.
  const stale = useRef(document.querySelector(TOAST)?.getAttribute("data-job-id") ?? null)

  function attempt() {
    setFailed(false)
    send().then(() => setQueued(true), () => setFailed(true))
  }

  useLayoutEffect(() => {
    const unhold = holdTracker()
    fly(ref.current!, from, () => { setLanded(true); unhold() })
    attempt()
    return unhold
  }, [])

  // Let go once the toast has taken over the same square, or soon after the job was queued without one.
  useEffect(() => {
    if (!landed || failed) return
    const taken = () => {
      const toast = document.querySelector(TOAST)
      if (toast && toast.getAttribute("data-job-id") !== stale.current) release()
    }
    taken()
    const observer = new MutationObserver(taken)
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-job-id"] })
    const fallback = queued ? setTimeout(release, SETTLE_MS) : undefined
    return () => { observer.disconnect(); clearTimeout(fallback) }
  }, [landed, failed, queued, release])

  return (
    <div
      ref={ref}
      data-slot="tracker-handoff"
      style={{ left: window.innerWidth - MARGIN - SQUARE, top: window.innerHeight - MARGIN - SQUARE, width: SQUARE, height: SQUARE }}
      className="bg-popover text-popover-foreground border-hairline fixed z-[60] grid place-items-center rounded-2xl border p-4 [filter:drop-shadow(0_8px_24px_rgb(11_11_12/0.18))]"
    >
      {failed ? (
        <div role="alert" className="grid justify-items-center gap-2 text-center text-xs">
          <p className="text-tone-danger">{labels.failed}</p>
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="xs" onClick={attempt} className="transition-[color,background-color,box-shadow]">{labels.retry}</Button>
            <Button type="button" variant="ghost" size="icon-xs" aria-label={labels.close} onClick={release} className="transition-[color,background-color]"><X /></Button>
          </div>
        </div>
      ) : (
        <Loader2 aria-hidden className={cn("text-muted-foreground size-6 motion-safe:animate-spin")} />
      )}
    </div>
  )
}

/**
 * A card that confirmed a slow job turns into the spinner square, flies to the corner and hands the
 * surface to the tracker toast. The square owns the send from here: the card is already gone, so a
 * failure shows on the square with a retry, and the retry is the same call (and so the same request).
 */
export function handOffToTracker(from: DOMRect, send: () => Promise<unknown>, labels: HandoffLabels) {
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  // Unmounting from inside the root's own effect is not allowed while it renders; let it finish first.
  const release = () => queueMicrotask(() => { root.unmount(); container.remove() })
  root.render(<Square from={from} send={send} labels={labels} release={release} />)
}
