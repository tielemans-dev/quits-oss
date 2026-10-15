import { useEffect, useRef, type CSSProperties } from "react"

import { useI18n } from "../../lib/i18n/react"
import { cn } from "../../lib/utils"
import { Button } from "../ui/button"
import { requestCardFor, type RequestIntent } from "./request-intent"

/** Stagger position of a part of the slot's content; parts rise in one after the other. */
export const stagger = (index: number) => ({
  "data-stagger": "",
  style: { "--stagger": index } as CSSProperties,
})

/**
 * Where a card for a request goes, in the palette and under the command bar. It brings the
 * card into focus, staggers its content in, and hands it the way back. `delay` is how long
 * the surface around it needs before its content starts, so nothing arrives onto a blank frame.
 */
export function RequestCardSlot({
  intent,
  onDismiss,
  delay = 0,
  className,
}: {
  intent: RequestIntent
  onDismiss: () => void
  delay?: number
  className?: string
}) {
  const { t } = useI18n()
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => ref.current?.focus({ preventScroll: true }), [])
  const Card = requestCardFor(intent.kind)

  return (
    <div
      ref={ref}
      role="region"
      tabIndex={-1}
      data-slot="request-card-slot"
      aria-label={t("shell.request.slotLabel")}
      style={{ "--stagger-delay": `${delay}ms` } as CSSProperties}
      className={cn("request-stagger outline-none", className)}
    >
      {Card ? (
        <Card intent={intent} onDismiss={onDismiss} />
      ) : (
        <div className="space-y-3 p-4">
          <div {...stagger(0)}>
            <p className="font-semibold">{t(`shell.request.title.${intent.kind}`)}</p>
            <p className="text-muted-foreground mt-0.5 truncate text-sm">{intent.input}</p>
          </div>
          <div {...stagger(1)} className="flex justify-end">
            {/* The shadcn default animates every property; name the ones that change. */}
            <Button type="button" variant="secondary" onClick={onDismiss} className="transition-[color,background-color,box-shadow]">
              {t("shell.request.dismiss")}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
