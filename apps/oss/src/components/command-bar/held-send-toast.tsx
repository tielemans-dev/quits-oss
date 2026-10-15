import { useEffect, useState } from "react"

import { useI18n } from "../../lib/i18n/react"
import { Button } from "../ui/button"
import { dismissHeldSend, useHeldSends, type HeldSend } from "./held-send"

function HeldSendRow({ entry }: { entry: HeldSend }) {
  const { t } = useI18n()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (entry.phase !== "holding") return
    const tick = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(tick)
  }, [entry.phase])
  const seconds = Math.max(1, Math.ceil((entry.deadline - now) / 1000))
  const text = entry.phase === "holding" ? t("shell.request.undo.holding", { customer: entry.customer, seconds })
    : entry.phase === "sending" ? t("shell.request.undo.sending", { customer: entry.customer })
    : t("shell.request.undo.failed", { customer: entry.customer })

  return (
    <div
      role={entry.phase === "failed" ? "alert" : "status"}
      data-phase={entry.phase}
      className="bg-popover text-popover-foreground border-hairline animate-in fade-in-0 slide-in-from-bottom-2 flex items-center gap-3 rounded-2xl border p-3 pl-4 text-sm shadow-lg duration-300 motion-reduce:slide-in-from-bottom-0"
    >
      <div className="min-w-0 flex-1">
        <p className="truncate tabular-nums">{text}</p>
        <p className="text-muted-foreground tabular-nums">{entry.amount}</p>
      </div>
      {entry.phase !== "sending" && (
        /* The shadcn default animates every property; name the ones that change. */
        <Button type="button" variant="outline" size="sm" onClick={() => dismissHeldSend(entry.id)} className="transition-[color,background-color,box-shadow]">
          {entry.phase === "holding" ? t("shell.request.undo.action") : t("shell.request.undo.close")}
        </Button>
      )}
    </div>
  )
}

/** The toast of a send that Fortryd can still stop; the countdown only reads the store's deadline. */
export function HeldSendToast() {
  const held = useHeldSends()
  if (!held.length) return null
  return (
    <div data-slot="held-send-toast" className="fixed bottom-4 left-1/2 z-50 grid w-[26rem] max-w-[calc(100vw-2rem)] -translate-x-1/2 gap-2">
      {held.map(entry => <HeldSendRow key={entry.id} entry={entry} />)}
    </div>
  )
}
