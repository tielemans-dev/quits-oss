import { useRef, useState } from "react"
import { format, isValid, parseISO } from "date-fns"
import { da, enUS } from "date-fns/locale"
import { CalendarIcon, X } from "lucide-react"
import { formatIsoDateForInputDisplay, parseLocalizedDateInput } from "../lib/i18n/date-input"
import { translate } from "../lib/i18n/translate"
import { normalizeLocale } from "../lib/i18n/locale"
import { Button } from "./ui/button"
import { Calendar } from "./ui/calendar"
import { Input } from "./ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover"

type LocalizedDateFieldProps = {
  id?: string
  value: string
  onChange: (value: string) => void
  locale?: string | null
  placeholder: string
  clearLabel?: string
  disabled?: boolean
  required?: boolean
  invalid?: boolean
  describedBy?: string
}

function resolveCalendarLocale(locale?: string | null) {
  const normalized = normalizeLocale(locale).toLowerCase()
  if (normalized.startsWith("da")) return da
  return enUS
}

function parseSelectedDate(value: string) {
  if (!value) return undefined
  const parsed = parseISO(value)
  if (!isValid(parsed)) return undefined
  return parsed
}

/**
 * A calendar date written the way the locale writes it (20.10.2026 in Danish), whatever the
 * browser's language. It can be typed or picked from the calendar; the value is always ISO.
 */
export function LocalizedDateField({
  id,
  value,
  onChange,
  locale,
  placeholder,
  clearLabel,
  disabled,
  required,
  invalid,
  describedBy,
}: LocalizedDateFieldProps) {
  const selectedDate = parseSelectedDate(value)
  // The text being typed; null shows the value. Text that is not a date stays, marked invalid,
  // and clears the value so a stale date is not saved in its place.
  const [typed, setTyped] = useState<string | null>(null)
  // Clicking the text opens the calendar beside it and leaves the focus for typing; the button moves the focus into it.
  const [open, setOpen] = useState<false | "field" | "calendar">(false)
  const field = useRef<HTMLInputElement>(null)
  const unreadable = typed !== null && typed.trim() !== "" && parseLocalizedDateInput(typed, locale) === null

  function commit() {
    if (typed === null) return
    const date = typed.trim() ? parseLocalizedDateInput(typed, locale) : ""
    if (date !== null) setTyped(null)
    if ((date ?? "") !== value) onChange(date ?? "")
  }

  function choose(date: string) {
    setTyped(null)
    setOpen(false)
    onChange(date)
  }

  return (
    <div className="relative">
      <Input
        ref={field}
        id={id}
        value={typed ?? (value ? formatIsoDateForInputDisplay(value, locale) : "")}
        placeholder={placeholder}
        autoComplete="off"
        disabled={disabled}
        aria-required={required || undefined}
        aria-invalid={invalid || unreadable || undefined}
        aria-describedby={describedBy}
        className="pr-10"
        onClick={() => { if (!open) setOpen("field") }}
        onChange={(event) => setTyped(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            // Read the date before a surrounding form acts on the old value.
            event.preventDefault()
            commit()
          }
        }}
      />
      <Popover open={Boolean(open)} onOpenChange={(next) => setOpen(next ? "calendar" : false)}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={disabled}
            aria-label={translate("dateField.openCalendar", locale)}
            className="absolute top-1/2 right-1 -translate-y-1/2"
          >
            <CalendarIcon className="size-4 opacity-70" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          className="w-auto p-0"
          align="end"
          onOpenAutoFocus={(event) => { if (open === "field") event.preventDefault() }}
          onInteractOutside={(event) => { if (event.target === field.current) event.preventDefault() }}
        >
          <Calendar
            mode="single"
            locale={resolveCalendarLocale(locale)}
            selected={selectedDate}
            defaultMonth={selectedDate}
            onSelect={(date) => choose(date ? format(date, "yyyy-MM-dd") : "")}
            initialFocus={open === "calendar"}
          />
          {value ? (
            <div className="border-t p-2">
              <Button type="button" variant="ghost" size="sm" className="w-full" onClick={() => choose("")}>
                <X className="size-4" />
                {clearLabel ?? translate("docForm.clear", locale)}
              </Button>
            </div>
          ) : null}
        </PopoverContent>
      </Popover>
    </div>
  )
}
