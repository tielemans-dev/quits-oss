import { ArrowUp, Sparkles } from "lucide-react"
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react"

import { useI18n } from "../../lib/i18n/react"
import { DURATION } from "../../lib/motion"
import { readHandoff } from "../../lib/request-handoff"
import { cn } from "../../lib/utils"
import { Button } from "../ui/button"
import { onRequestOpen } from "./request-events"
import { RequestCardSlot } from "./request-card-slot"
import type { RequestIntent, RequestRecognizer } from "./request-intent"
import { useFollowHeight } from "./use-morph"

/**
 * The pill under the greeting on Overblik: write a request, and when it reads as one, the pill
 * grows into the card slot in place. Closing the card puts the cursor back in the pill. With
 * `onSearch` it is also the page's search field: typing hands the text over (the palette grows out
 * of the pill and answers requests as well), and the pill only opens cards it is asked to.
 */
export function CommandBar({ recognize, suggest, onSearch, className }: { recognize: RequestRecognizer; suggest?: (input: string, signal: AbortSignal) => Promise<RequestIntent | null>; onSearch?: (from: HTMLFormElement, query: string) => void; className?: string }) {
  const { t } = useI18n()
  // Back from the form with an edited invoice, the card opens again for the request it began with.
  const [returned] = useState(() => readHandoff("card"))
  const [value, setValue] = useState(returned?.input ?? "")
  const [intent, setIntent] = useState<RequestIntent | null>(() => (returned ? recognize(returned.input, returned.suggested) : null))
  const inputRef = useRef<HTMLInputElement>(null)
  const follow = useFollowHeight(DURATION.base)
  const [suggestion, setSuggestion] = useState<RequestIntent | null>(null)
  const recognized = recognize(value) ?? (suggestion?.input === value ? suggestion : null)
  useEffect(() => {
    if (!suggest || intent || recognize(value)) return
    const run = new AbortController()
    suggest(value, run.signal).then(result => { if (!run.signal.aborted) setSuggestion(result) })
    return () => run.abort()
  }, [value, intent, recognize, suggest])
  const open = useRef(intent !== null)
  open.current = intent !== null

  // A summary row can ask for a card; it never replaces one the person is working in.
  useEffect(
    () =>
      onRequestOpen((request) => {
        if (open.current) return
        setValue(request.input)
        setIntent(request)
      }),
    []
  )

  function submit(event: FormEvent) {
    event.preventDefault()
    if (recognized && !intent) setIntent(recognized)
  }

  function dismiss() {
    setIntent(null)
    setValue("")
    inputRef.current?.focus()
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape" && intent) dismiss()
  }

  return (
    <form
      data-slot="command-bar"
      onSubmit={submit}
      onKeyDown={onKeyDown}
      className={cn(
        "border-hairline bg-panel overflow-hidden border shadow-xs",
        // The corners ease from pill to card in step with the height. Both are real radii: from
        // `rounded-full` the radius stays a pill until the very end, then snaps.
        "[transition:border-radius_var(--duration-base)_var(--ease-enter)] motion-reduce:[transition:none]",
        intent ? "rounded-2xl" : "rounded-[29px]",
        className
      )}
    >
      {/* The pill follows this: it grows with the card, and again when the card's data arrives. */}
      <div ref={follow}>
        <div className="flex h-14 items-center gap-3 pr-2 pl-5">
          <Sparkles className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            value={value}
            readOnly={intent !== null}
            onChange={(event) => {
              if (onSearch && event.currentTarget.form) onSearch(event.currentTarget.form, event.target.value)
              else setValue(event.target.value)
            }}
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
      </div>
    </form>
  )
}
