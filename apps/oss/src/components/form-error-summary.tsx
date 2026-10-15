import { useEffect, useId, useRef, type RefObject } from "react"
import { useI18n } from "../lib/i18n/react"

export type SummaryError = { target: string; label: string; message: string }

/** Submit attempts trigger focus; live corrections only update the list. */
export function FormErrorSummary({ errors, attempt, scope }: {
  errors: SummaryError[]
  attempt: number
  scope: RefObject<HTMLElement | null>
}) {
  const { t } = useI18n()
  const titleId = useId()
  const summary = useRef<HTMLDivElement>(null)
  const focusedAttempt = useRef(0)
  useEffect(() => {
    if (!errors.length || !attempt || focusedAttempt.current === attempt) return
    focusedAttempt.current = attempt
    summary.current?.focus({ preventScroll: true })
    summary.current?.scrollIntoView?.({ block: "center" })
  }, [attempt, errors.length])
  if (!attempt || !errors.length) return null
  return <div ref={summary} role="alert" tabIndex={-1} aria-labelledby={titleId} aria-describedby={`${titleId}-hint`}
    className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive animate-in fade-in-0 duration-(--duration-fade) ease-(--ease-enter) motion-reduce:animate-none">
    <h2 id={titleId} className="font-semibold">{t(errors.length === 1 ? "summary.title.one" : "summary.title.other", { n: errors.length })}</h2>
    <p id={`${titleId}-hint`}>{t("summary.hint")}</p>
    <ul className="mt-2 list-disc pl-5">
      {errors.map(({ target, label, message }, index) => <li key={`${target}-${index}`}>
        <a href={target.startsWith("#") ? target : "#"} className="underline underline-offset-2" onClick={event => {
          event.preventDefault()
          const field = scope.current?.querySelector<HTMLElement>(target)
          field?.focus({ preventScroll: true })
          field?.scrollIntoView?.({ block: "center" })
        }}>{label}: {message}</a>
      </li>)}
    </ul>
  </div>
}
