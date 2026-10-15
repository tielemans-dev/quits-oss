import { useEffect, useRef, useState } from "react"

import { useI18n } from "../../lib/i18n/react"
import { UNDO_HOLD_LEASE_MS, UNDO_WINDOW_MS } from "../../lib/undo-window"
import { cn } from "../../lib/utils"
import { Button } from "../ui/button"
import { removeUndo, syncHeldJobs, useUndoItems, type UndoItem } from "./undo-store"

const TICK_MS = 100
/** A paused countdown renews its hold this often; the lease outlasts a missed beat. */
const BEAT_MS = 2000
const FADE_MS = 200
const NOTE_MS = 3000

const TITLE = { invoice: "undo.title.invoice", reminders: "undo.title.reminders", paid: "undo.title.paid" } as const

/**
 * The toast for one action that can still be taken back. The countdown pauses while the pointer is
 * over it or focus is inside it; a send the server holds is kept held for as long as it is paused.
 * Entering and leaving fade; the bar is dropped under reduced motion (the seconds remain).
 */
function UndoToast({ item }: { item: UndoItem }) {
  const { t } = useI18n()
  const [left, setLeft] = useState(() => Math.max(0, item.endsAt - Date.now()))
  const leftRef = useRef(left)
  const [paused, setPaused] = useState(false)
  const wasPaused = useRef(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ text: string; failed: boolean } | null>(null)
  const [shown, setShown] = useState(false)
  const settled = busy || note !== null

  const leave = (delay: number) => setTimeout(() => { setShown(false); setTimeout(() => removeUndo(item.id), FADE_MS) }, delay)
  useEffect(() => { setShown(true) }, [])

  async function elapse() {
    setBusy(true)
    const result = await item.elapsed?.().catch(() => undefined)
    if (result) setNote({ text: result.failed === null ? t("undo.invoice.sent") : t("undo.invoice.failed"), failed: result.failed !== null })
    leave(result ? NOTE_MS : 0)
  }

  async function undo() {
    setBusy(true)
    try {
      await item.undo()
      setNote({ text: t("undo.done"), failed: false })
    } catch {
      setNote({ text: t("undo.tooLate"), failed: true })
    }
    leave(NOTE_MS)
  }

  useEffect(() => {
    if (paused || settled) return
    const until = Date.now() + leftRef.current
    // Back from a pause the server is told the exact time left, taking back the lease.
    if (wasPaused.current) void item.keepHeld?.(leftRef.current).catch(() => {})
    wasPaused.current = false
    const timer = setInterval(() => {
      leftRef.current = Math.max(0, until - Date.now())
      setLeft(leftRef.current)
      if (leftRef.current === 0) { clearInterval(timer); void elapse() }
    }, TICK_MS)
    return () => clearInterval(timer)
  }, [paused, settled])

  useEffect(() => {
    if (!paused || settled || !item.keepHeld) return
    wasPaused.current = true
    const beat = () => void item.keepHeld!(leftRef.current + UNDO_HOLD_LEASE_MS).catch(() => {})
    beat()
    const timer = setInterval(beat, BEAT_MS)
    return () => clearInterval(timer)
  }, [paused, settled, item])

  const pause = (on: boolean) => () => setPaused(on)
  return (
    <div
      role={note?.failed ? "alert" : "status"}
      data-slot="undo-toast"
      data-job-id={item.jobId}
      onPointerEnter={pause(true)}
      onPointerLeave={pause(false)}
      onFocus={pause(true)}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setPaused(false) }}
      className={cn(
        "bg-popover text-popover-foreground border-hairline overflow-hidden rounded-2xl border opacity-0 transition-opacity duration-200 [filter:drop-shadow(0_8px_24px_rgb(11_11_12/0.18))]",
        shown && "opacity-100"
      )}
    >
      <div className="flex items-center gap-3 p-3 text-sm">
        <p className={cn("min-w-0 flex-1 truncate font-semibold", note?.failed && "text-tone-danger")}>
          {note ? note.text : t(TITLE[item.kind], { count: item.count ?? 0 })}
        </p>
        {!note && (
          <>
            <span aria-hidden className="text-muted-foreground tabular-nums">{t("undo.seconds", { seconds: Math.ceil(left / 1000) })}</span>
            <Button type="button" variant="outline" size="xs" disabled={busy} onClick={() => void undo()} className="transition-[color,background-color,box-shadow]">
              {t("undo.action")}
            </Button>
          </>
        )}
      </div>
      {!note && (
        <div aria-hidden className="bg-foreground/10 h-0.5 motion-reduce:hidden">
          <div className="bg-tone-progress h-full transition-[width] duration-100 ease-linear" style={{ width: `${(left / UNDO_WINDOW_MS) * 100}%` }} />
        </div>
      )}
    </div>
  )
}

/** Mounted once in the app layout. On open it picks up sends the server is still holding. */
export function UndoToaster() {
  const { t } = useI18n()
  const items = useUndoItems()
  useEffect(() => { void syncHeldJobs() }, [])
  return (
    <section aria-label={t("undo.region")} className="fixed right-4 bottom-4 z-50 flex w-[22rem] max-w-[calc(100vw-2rem)] flex-col gap-2">
      {items.map(item => <UndoToast key={item.id} item={item} />)}
    </section>
  )
}
