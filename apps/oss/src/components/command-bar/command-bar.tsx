import { ArrowUp, Sparkles } from "lucide-react"
import { useRef, useState, type FormEvent, type KeyboardEvent } from "react"

import { useI18n } from "../../lib/i18n/react"
import { DURATION } from "../../lib/motion"
import { readHandoff } from "../../lib/request-handoff"
import { cn } from "../../lib/utils"
import { Button } from "../ui/button"
import { RequestCardSlot } from "./request-card-slot"
import type { RequestIntent, RequestRecognizer } from "./request-intent"
import { useMorph } from "./use-morph"

/**
 * The pill under the greeting on Overblik: write a request, and when it reads as one, the pill
 * grows into the card slot in place. Anything else does nothing here; search stays in the top bar
 * and ⌘K. Closing the card puts the cursor back in the pill.
 */
export function CommandBar({ recognize, className }: { recognize: RequestRecognizer; className?: string }) {
  const { t } = useI18n()
  // Back from the form with an edited invoice, the card opens again for the request it began with.
  const [returned] = useState(() => readHandoff("card")?.input)
  const [value, setValue] = useState(returned ?? "")
  const [intent, setIntent] = useState<RequestIntent | null>(() => (returned ? recognize(returned) : null))
  const inputRef = useRef<HTMLInputElement>(null)
  const morph = useMorph<HTMLFormElement>(DURATION.base)
  const recognized = recognize(value)

  function submit(event: FormEvent) {
    event.preventDefault()
    if (recognized && !intent) morph.run(() => setIntent(recognized))
  }

  function dismiss() {
    morph.run(() => {
      setIntent(null)
      setValue("")
    })
    inputRef.current?.focus()
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape" && intent) dismiss()
  }

  return (
    <form
      ref={morph.ref}
      data-slot="command-bar"
      onSubmit={submit}
      onKeyDown={onKeyDown}
      className={cn(
        "border-hairline bg-panel overflow-hidden border shadow-xs",
        // The corners ease from pill to card in step with the height.
        "[transition:border-radius_var(--duration-base)_var(--ease-enter)] motion-reduce:[transition:none]",
        intent ? "rounded-[18px]" : "rounded-full",
        className
      )}
    >
      <div className="flex h-14 items-center gap-3 pr-2 pl-5">
        <Sparkles className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
        <input
          ref={inputRef}
          type="text"
          value={value}
          readOnly={intent !== null}
          onChange={(event) => setValue(event.target.value)}
          aria-label={t("dashboard.commandBar.label")}
          placeholder={t("dashboard.commandBar.placeholder")}
          autoComplete="off"
          spellCheck={false}
          className="placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-base outline-none"
        />
        {/* The shadcn default animates every property; name the ones that change. */}
        <Button
          type="submit"
          size="icon-sm"
          variant="secondary"
          disabled={!recognized || intent !== null}
          aria-label={t("dashboard.commandBar.submit")}
          className="rounded-full transition-[color,background-color,opacity]"
        >
          <ArrowUp aria-hidden="true" />
        </Button>
      </div>
      {intent && <RequestCardSlot intent={intent} onDismiss={dismiss} className="border-hairline border-t" />}
    </form>
  )
}
